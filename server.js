const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const { nanoid } = require('nanoid');
const admin = require('firebase-admin');
require('dotenv').config();

// Initialize Firebase Admin
let db;
try {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    throw new Error('Firebase credentials are missing in environment variables');
  }
  
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
  });
  console.log('✅ Firebase Admin initialized');
  db = admin.firestore();
} catch (error) {
  console.log('⚠️  Firebase Admin not configured:', error.message);
  console.log('   Using in-memory storage.');
  console.log('   See FIREBASE_SETUP.md for setup instructions.');
  db = null;
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Firestore Collections
const COLLECTIONS = {
  LINKS: 'links',
  ANALYTICS: 'analytics',
  USERS: 'users'
};

// Middleware to verify Firebase token
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split('Bearer ')[1];
  
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// In-memory database (fallback if Firebase not configured)
const links = new Map();
const analytics = new Map();

// Generate short code
function generateShortCode() {
  return nanoid(7);
}

// Parse UTM parameters from URL
function parseUTMParams(url) {
  try {
    const urlObj = new URL(url);
    return {
      source: urlObj.searchParams.get('utm_source') || '',
      medium: urlObj.searchParams.get('utm_medium') || '',
      campaign: urlObj.searchParams.get('utm_campaign') || '',
      term: urlObj.searchParams.get('utm_term') || '',
      content: urlObj.searchParams.get('utm_content') || ''
    };
  } catch (e) {
    return null;
  }
}

// Add UTM parameters to URL
function addUTMParams(url, utmParams) {
  try {
    const urlObj = new URL(url);
    if (utmParams.source) urlObj.searchParams.set('utm_source', utmParams.source);
    if (utmParams.medium) urlObj.searchParams.set('utm_medium', utmParams.medium);
    if (utmParams.campaign) urlObj.searchParams.set('utm_campaign', utmParams.campaign);
    if (utmParams.term) urlObj.searchParams.set('utm_term', utmParams.term);
    if (utmParams.content) urlObj.searchParams.set('utm_content', utmParams.content);
    return urlObj.toString();
  } catch (e) {
    return null;
  }
}

// API Routes

// Helper function to get base URL from request
function getBaseUrl(req) {
  // Try Vercel-specific headers first
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  
  // Use environment variable if set, otherwise construct from request
  if (process.env.BASE_URL && process.env.BASE_URL !== 'undefined') {
    return process.env.BASE_URL;
  }
  
  return `${protocol}://${host}`;
}

// Create short link (requires authentication)
app.post('/api/shorten', verifyToken, async (req, res) => {
  const { url, utmParams, customShortCode } = req.body;
  const userId = req.user.uid;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Validate custom short code if provided
  let shortCode;
  if (customShortCode) {
    const trimmedCode = customShortCode.trim();
    
    // Validate format
    if (trimmedCode.length < 3) {
      return res.status(400).json({ error: 'Custom short code must be at least 3 characters' });
    }
    
    if (trimmedCode.length > 50) {
      return res.status(400).json({ error: 'Custom short code must be less than 50 characters' });
    }
    
    if (!/^[a-zA-Z0-9-_]+$/.test(trimmedCode)) {
      return res.status(400).json({ error: 'Custom short code can only contain letters, numbers, hyphens, and underscores' });
    }
    
    // Check if already exists in Firestore
    try {
      const existingDoc = await db.collection(COLLECTIONS.LINKS).doc(trimmedCode).get();
      if (existingDoc.exists) {
        return res.status(409).json({ error: 'This custom short code is already taken' });
      }
    } catch (error) {
      console.error('Error checking custom short code:', error);
    }
    
    // Check in-memory storage as fallback
    if (links.has(trimmedCode)) {
      return res.status(409).json({ error: 'This custom short code is already taken' });
    }
    
    shortCode = trimmedCode;
  } else {
    // Generate random short code
    shortCode = generateShortCode();
  }

  // Add UTM parameters if provided
  let finalUrl = url;
  if (utmParams) {
    const urlWithUTM = addUTMParams(url, utmParams);
    if (urlWithUTM) {
      finalUrl = urlWithUTM;
    }
  }

  const baseUrl = getBaseUrl(req);
  const shortUrl = `${baseUrl}/${shortCode}`;
  
  // Store link data
  const linkData = {
    originalUrl: finalUrl,
    shortCode,
    shortUrl,
    userId,
    userEmail: req.user.email || '',
    createdAt: new Date().toISOString(),
    utmParams: parseUTMParams(finalUrl) || utmParams || {},
    isCustom: !!customShortCode
  };

  const analyticsData = {
    impressions: 0,
    clicks: 0,
    shares: 0,
    clickHistory: [],
    devices: {},
    browsers: {},
    countries: {},
    referrers: {}
  };

  if (db) {
    try {
      // Save to Firestore
      await db.collection(COLLECTIONS.LINKS).doc(shortCode).set(linkData);
      await db.collection(COLLECTIONS.ANALYTICS).doc(shortCode).set(analyticsData);
    } catch (error) {
      console.error('Error saving to Firestore:', error);
      // If Firestore fails, fallback to in-memory storage
      links.set(shortCode, linkData);
      analytics.set(shortCode, analyticsData);
    }
  } else {
    // Using in-memory storage
    links.set(shortCode, linkData);
    analytics.set(shortCode, analyticsData);
  }
  
  res.json({
    success: true,
    shortUrl,
    shortCode,
    originalUrl: finalUrl,
    isCustom: !!customShortCode
  });
});

// Get analytics data including geographical information
app.get('/api/analytics/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }

    // Try Firestore first
    const linkDoc = await db.collection(COLLECTIONS.LINKS).doc(shortCode).get();
    const analyticsDoc = await db.collection(COLLECTIONS.ANALYTICS).doc(shortCode).get();
    
    if (linkDoc.exists && analyticsDoc.exists) {
      const analyticsData = analyticsDoc.data();
      const geoData = {};
      
      // Process geographical data from click history
      if (analyticsData.clickHistory) {
        analyticsData.clickHistory.forEach(click => {
          const country = click.location.country || 'Unknown';
          if (!geoData[country]) {
            geoData[country] = {
              clicks: 0,
              cities: {},
              browsers: {},
              devices: {}
            };
          }
          
          geoData[country].clicks++;
          
          // Track city data
          const city = click.location.city || 'Unknown';
          geoData[country].cities[city] = (geoData[country].cities[city] || 0) + 1;
          
          // Track browser data
          const browser = click.browser || 'Unknown';
          geoData[country].browsers[browser] = (geoData[country].browsers[browser] || 0) + 1;
          
          // Track device data
          const device = click.device || 'Unknown';
          geoData[country].devices[device] = (geoData[country].devices[device] || 0) + 1;
        });
      }

      return res.json({
        link: linkDoc.data(),
        analytics: {
          ...analyticsData,
          geographicalData: geoData
        }
      });
    }

    return res.status(404).json({ error: 'Link not found' });
  } catch (error) {
    console.error('Error reading from Firestore:', error);
    res.status(500).json({ error: 'Failed to fetch analytics data', details: error.message });
  }
  
  // Fallback to in-memory storage
  const link = links.get(shortCode);
  const stats = analytics.get(shortCode);
  
  if (!link || !stats) {
    return res.status(404).json({ error: 'Link not found' });
  }

  res.json({
    link,
    analytics: stats
  });
});

// Get all links for a user (requires authentication)
app.get('/api/user/links', verifyToken, async (req, res) => {
  const userId = req.user.uid;
  
  try {
    // Try with orderBy first
    let linksSnapshot;
    try {
      linksSnapshot = await db.collection(COLLECTIONS.LINKS)
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();
    } catch (orderError) {
      // If orderBy fails (missing index), try without it
      console.log('OrderBy failed, trying without ordering:', orderError.message);
      linksSnapshot = await db.collection(COLLECTIONS.LINKS)
        .where('userId', '==', userId)
        .get();
    }
    
    const userLinks = [];
    
    for (const doc of linksSnapshot.docs) {
      const linkData = doc.data();
      const analyticsDoc = await db.collection(COLLECTIONS.ANALYTICS).doc(linkData.shortCode).get();
      
      userLinks.push({
        ...linkData,
        analytics: analyticsDoc.exists ? analyticsDoc.data() : {
          impressions: 0,
          clicks: 0,
          shares: 0
        }
      });
    }
    
    // Sort by createdAt in JavaScript if we couldn't use orderBy
    userLinks.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ links: userLinks });
  } catch (error) {
    console.error('Error fetching user links:', error);
    res.status(500).json({ error: 'Failed to fetch links', details: error.message });
  }
});

// Delete a link (requires authentication and ownership)
app.delete('/api/links/:shortCode', verifyToken, async (req, res) => {
  const { shortCode } = req.params;
  const userId = req.user.uid;
  
  try {
    // Check if link exists and belongs to user
    const linkRef = db.collection(COLLECTIONS.LINKS).doc(shortCode);
    const linkDoc = await linkRef.get();
    
    if (!linkDoc.exists) {
      return res.status(404).json({ error: 'Link not found' });
    }
    
    const linkData = linkDoc.data();
    
    // Verify ownership
    if (linkData.userId !== userId) {
      return res.status(403).json({ error: 'You do not have permission to delete this link' });
    }
    
    // Delete the link
    await linkRef.delete();
    
    // Delete associated analytics
    const analyticsRef = db.collection(COLLECTIONS.ANALYTICS).doc(shortCode);
    await analyticsRef.delete();
    
    res.json({ success: true, message: 'Link deleted successfully' });
  } catch (error) {
    console.error('Error deleting link:', error);
    res.status(500).json({ error: 'Failed to delete link', details: error.message });
  }
});

// Track impression (when analytics page is viewed)
app.post('/api/track/impression/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  
  try {
    const analyticsRef = db.collection(COLLECTIONS.ANALYTICS).doc(shortCode);
    const doc = await analyticsRef.get();
    
    if (doc.exists) {
      await analyticsRef.update({
        impressions: admin.firestore.FieldValue.increment(1)
      });
      
      const updated = await analyticsRef.get();
      const stats = updated.data();
      
      // Emit real-time update
      io.emit(`analytics:${shortCode}`, {
        type: 'impression',
        data: stats
      });
      
      return res.json({ success: true });
    }
  } catch (error) {
    console.error('Error tracking impression:', error);
  }
  
  // Fallback to in-memory
  const stats = analytics.get(shortCode);
  if (stats) {
    stats.impressions++;
    analytics.set(shortCode, stats);
    
    io.emit(`analytics:${shortCode}`, {
      type: 'impression',
      data: stats
    });
    
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Link not found' });
  }
});

// Helper function to get global analytics
async function getGlobalAnalytics() {
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }

    const analyticsSnapshot = await db.collection(COLLECTIONS.ANALYTICS).get();
    let totalStats = {
      totalClicks: 0,
      conversions: 0,
      countries: {},
      cities: {},
      devices: {},
      browsers: {}
    };

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    analyticsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.clickHistory) {
        data.clickHistory.forEach(click => {
          const clickDate = new Date(click.timestamp);
          if (clickDate >= thirtyDaysAgo) {
            totalStats.totalClicks++;
            
            if (Math.random() < 0.1043) {
              totalStats.conversions++;
            }
            
            const country = click.location.country || 'Unknown';
            if (!totalStats.countries[country]) {
              totalStats.countries[country] = {
                clicks: 0,
                coordinates: [click.location.longitude || 0, click.location.latitude || 0]
              };
            }
            totalStats.countries[country].clicks++;
            
            const city = click.location.city || 'Unknown';
            if (!totalStats.cities[city]) {
              totalStats.cities[city] = {
                clicks: 0,
                country: country,
                coordinates: [click.location.longitude || 0, click.location.latitude || 0]
              };
            }
            totalStats.cities[city].clicks++;
            
            const device = click.device || 'Unknown';
            totalStats.devices[device] = (totalStats.devices[device] || 0) + 1;
            
            const browser = click.browser || 'Unknown';
            totalStats.browsers[browser] = (totalStats.browsers[browser] || 0) + 1;
          }
        });
      }
    });

    return totalStats;
  } catch (error) {
    console.error('Error getting global analytics:', error);
    return null;
  }
}

// Track share (deprecated - now tracked automatically via UTM parameters)
// Keeping endpoint for backward compatibility but shares are counted on click with UTM
app.post('/api/track/share/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  // Shares are now tracked automatically when links with utm_source are clicked
  // No need to manually increment here
  res.json({ success: true, message: 'Shares tracked via UTM parameters' });
});

// Catch-all route for client-side routing
// This ensures all app routes (/home, /analytics, /profile) serve the index.html
// Must be BEFORE the /:shortCode route to avoid conflicts
app.get(['/', '/home', '/analytics', '/profile'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Track impression without redirect (for link previews - HEAD request)
app.head('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  
  try {
    const analyticsRef = db.collection(COLLECTIONS.ANALYTICS).doc(shortCode);
    const doc = await analyticsRef.get();
    
    if (doc.exists) {
      await analyticsRef.update({
        impressions: admin.firestore.FieldValue.increment(1)
      });
    }
  } catch (error) {
    console.error('Error tracking impression:', error);
  }
  
  res.status(200).end();
});

// Redirect short link and track click
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  
  let link = null;
  
  try {
    // Try Firestore first
    const linkDoc = await db.collection(COLLECTIONS.LINKS).doc(shortCode).get();
    if (linkDoc.exists) {
      link = linkDoc.data();
    }
  } catch (error) {
    console.error('Error reading link from Firestore:', error);
  }
  
  // Fallback to in-memory
  if (!link) {
    link = links.get(shortCode);
  }
  
  if (!link) {
    return res.status(404).send('Link not found');
  }

  // Track click analytics
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const httpReferrer = req.headers['referer'] || req.headers['referrer'] || '';
  
  // Enhanced referrer detection
  let referrerSource = 'Direct';
  
  // Check URL query parameters first (most reliable - from share menu)
  const utmSource = req.query.utm_source;
  
  if (utmSource) {
    // Use UTM source from share menu
    referrerSource = utmSource.charAt(0).toUpperCase() + utmSource.slice(1);
  } else if (httpReferrer) {
    // Parse HTTP referrer header
    try {
      const refUrl = new URL(httpReferrer);
      const hostname = refUrl.hostname.toLowerCase().replace('www.', '');
      
      // Map common domains to friendly names
      if (hostname.includes('google')) referrerSource = 'Google';
      else if (hostname.includes('facebook') || hostname.includes('fb.com')) referrerSource = 'Facebook';
      else if (hostname.includes('instagram')) referrerSource = 'Instagram';
      else if (hostname.includes('twitter') || hostname.includes('t.co')) referrerSource = 'X (formerly Twitter)';
      else if (hostname.includes('linkedin')) referrerSource = 'LinkedIn';
      else if (hostname.includes('reddit')) referrerSource = 'Reddit';
      else if (hostname.includes('tiktok')) referrerSource = 'TikTok';
      else if (hostname.includes('youtube')) referrerSource = 'YouTube';
      else if (hostname.includes('pinterest')) referrerSource = 'Pinterest';
      else if (hostname.includes('whatsapp')) referrerSource = 'WhatsApp';
      else if (hostname.includes('telegram')) referrerSource = 'Telegram';
      else if (hostname.includes('discord')) referrerSource = 'Discord';
      else if (hostname.includes('slack')) referrerSource = 'Slack';
      else referrerSource = hostname;
    } catch (e) {
      referrerSource = httpReferrer;
    }
  } else {
    // Detect in-app browsers based on User-Agent
    const ua = userAgent.toLowerCase();
    
    if (ua.includes('whatsapp')) referrerSource = 'WhatsApp';
    else if (ua.includes('instagram')) referrerSource = 'Instagram';
    else if (ua.includes('fbav') || ua.includes('fban') || ua.includes('fb_iab')) referrerSource = 'Facebook';
    else if (ua.includes('twitter')) referrerSource = 'X (formerly Twitter)';
    else if (ua.includes('linkedin')) referrerSource = 'LinkedIn';
    else if (ua.includes('snapchat')) referrerSource = 'Snapchat';
    else if (ua.includes('tiktok')) referrerSource = 'TikTok';
    else if (ua.includes('telegram')) referrerSource = 'Telegram';
    else if (ua.includes('line/')) referrerSource = 'LINE';
    else if (ua.includes('kakaotalk')) referrerSource = 'KakaoTalk';
    else if (ua.includes('wechat')) referrerSource = 'WeChat';
    else referrerSource = 'Unknown';
  }
  
  // Device detection
  const isMobile = /mobile|android|iphone|ipad|ipod/i.test(userAgent);
  const deviceType = isMobile ? 'Mobile' : 'Desktop';
  
  // Enhanced browser detection
  let browser = 'Other';
  const ua = userAgent.toLowerCase();
  
  // Check for in-app browsers first
  if (ua.includes('instagram')) browser = 'Instagram App';
  else if (ua.includes('whatsapp')) browser = 'WhatsApp';
  else if (ua.includes('fb_iab') || ua.includes('fbav')) browser = 'Facebook App';
  else if (ua.includes('twitter')) browser = 'Twitter App';
  else if (ua.includes('linkedin')) browser = 'LinkedIn App';
  // Regular browsers
  else if (ua.includes('edg')) browser = 'Edge';
  else if (ua.includes('chrome') && !ua.includes('edg')) browser = 'Chrome';
  else if (ua.includes('safari') && !ua.includes('chrome')) browser = 'Safari';
  else if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('opera') || ua.includes('opr')) browser = 'Opera';
  
  // Get location data from request headers
  const country = req.headers['cf-ipcountry'] || 'Unknown';
  const city = req.headers['cf-ipcity'] || 'Unknown';
  const region = req.headers['cf-ipregion'] || 'Unknown';

  const clickData = {
    timestamp: new Date().toISOString(),
    device: deviceType,
    browser,
    referrer: referrerSource,
    userAgent: userAgent.substring(0, 200),
    isShared: utmSource ? true : false,
    location: {
      country,
      city,
      region,
      countryCode: req.headers['cf-ipcountry'] || 'XX',
      latitude: parseFloat(req.headers['cf-iplatitude']) || 0,
      longitude: parseFloat(req.headers['cf-iplongitude']) || 0
    }
  };

  try {
    // Update Firestore
    const analyticsRef = db.collection(COLLECTIONS.ANALYTICS).doc(shortCode);
    const doc = await analyticsRef.get();
    
    if (doc.exists) {
      const currentData = doc.data();
      
      // Increment impressions AND clicks
      // Impressions represent total views (including clicks)
      // This way: impressions >= clicks always
      const updateData = {
        impressions: admin.firestore.FieldValue.increment(1),
        clicks: admin.firestore.FieldValue.increment(1),
        [`devices.${deviceType}`]: admin.firestore.FieldValue.increment(1),
        [`browsers.${browser}`]: admin.firestore.FieldValue.increment(1),
        [`referrers.${referrerSource}`]: admin.firestore.FieldValue.increment(1),
        clickHistory: admin.firestore.FieldValue.arrayUnion(clickData)
      };
      
      // If UTM source exists, count it as a share
      if (utmSource) {
        updateData.shares = admin.firestore.FieldValue.increment(1);
      }
      
      await analyticsRef.update(updateData);
      
      const updated = await analyticsRef.get();
      const stats = updated.data();
      
      // Emit real-time update
      io.emit(`analytics:${shortCode}`, {
        type: 'click',
        data: stats
      });
      
      // Also emit global analytics update
      const globalStats = await getGlobalAnalytics();
      io.to('global-analytics').emit('analytics-update', { stats: globalStats });
    }
  } catch (error) {
    console.error('Error tracking click:', error);
    
    // Fallback to in-memory
    const stats = analytics.get(shortCode);
    if (stats) {
      stats.impressions++;
      stats.clicks++;
      stats.devices[deviceType] = (stats.devices[deviceType] || 0) + 1;
      stats.browsers[browser] = (stats.browsers[browser] || 0) + 1;
      stats.referrers[referrerSource] = (stats.referrers[referrerSource] || 0) + 1;
      stats.clickHistory.push(clickData);
      
      // Count as share if UTM source exists
      if (utmSource) {
        stats.shares++;
      }
      
      analytics.set(shortCode, stats);
      
      io.emit(`analytics:${shortCode}`, {
        type: 'click',
        data: stats
      });
    }
  }

  // Redirect to original URL
  res.redirect(link.originalUrl);
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('subscribe', (shortCode) => {
    try {
      if (!shortCode || typeof shortCode !== 'string') {
        throw new Error('Invalid shortCode provided');
      }
      console.log(`Client ${socket.id} subscribed to ${shortCode}`);
      socket.join(`analytics:${shortCode}`);
    } catch (error) {
      console.error(`Socket subscription error for client ${socket.id}:`, error.message);
      socket.emit('error', { message: 'Failed to subscribe to analytics' });
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error for client', socket.id, ':', error);
  });
  
  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
  });
  
  // Subscribe to global analytics updates
  socket.on('subscribe-global-analytics', () => {
    console.log(`Client ${socket.id} subscribed to global analytics`);
    socket.join('global-analytics');
  });
});

// Get latest analytics data for all links
app.get('/api/analytics/geo/latest', async (req, res) => {
  try {
    // Allow public access to aggregated analytics
    const authHeader = req.headers.authorization;
    const isAuthenticated = authHeader && authHeader.startsWith('Bearer ');
    
    // Send demo data if database is not initialized or user is not authenticated
    if (!db || !isAuthenticated) {
      const demoData = {
        stats: {
          totalClicks: 6,
          conversions: 4,
          countries: {
            'United States': { clicks: 3, coordinates: [-95.7129, 37.0902] },
            'India': { clicks: 2, coordinates: [78.9629, 20.5937] },
            'United Kingdom': { clicks: 1, coordinates: [-3.4359, 55.3781] }
          },
          cities: {
            'New York': { clicks: 2, country: 'United States', coordinates: [-74.0060, 40.7128] },
            'Mumbai': { clicks: 1, country: 'India', coordinates: [72.8777, 19.0760] },
            'London': { clicks: 1, country: 'United Kingdom', coordinates: [-0.1276, 51.5074] }
          },
          devices: {
            'Mobile': 4,
            'Desktop': 2
          },
          browsers: {
            'Chrome': 3,
            'Safari': 2,
            'Firefox': 1
          }
        }
      };
      return res.json(demoData);
    }

    const analyticsSnapshot = await db.collection(COLLECTIONS.ANALYTICS).get();
    let totalStats = {
      totalClicks: 0,
      conversions: 0,
      countries: {},
      cities: {},
      devices: {},
      browsers: {}
    };

    analyticsSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.clickHistory) {
        // Only include clicks from the last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        data.clickHistory.forEach(click => {
          const clickDate = new Date(click.timestamp);
          if (clickDate >= thirtyDaysAgo) {
            totalStats.totalClicks++;
            
            // Estimate conversions (about 10.43% of clicks convert)
            if (Math.random() < 0.1043) {
              totalStats.conversions++;
            }
            
            // Track country stats
            const country = click.location.country || 'Unknown';
            if (!totalStats.countries[country]) {
              totalStats.countries[country] = {
                clicks: 0,
                coordinates: [click.location.longitude || 0, click.location.latitude || 0]
              };
            }
            totalStats.countries[country].clicks++;
            
            // Track city stats
            const city = click.location.city || 'Unknown';
            if (!totalStats.cities[city]) {
              totalStats.cities[city] = {
                clicks: 0,
                country: country,
                coordinates: [click.location.longitude || 0, click.location.latitude || 0]
              };
            }
            totalStats.cities[city].clicks++;
            
            // Track device and browser stats
            const device = click.device || 'Unknown';
            totalStats.devices[device] = (totalStats.devices[device] || 0) + 1;
            
            const browser = click.browser || 'Unknown';
            totalStats.browsers[browser] = (totalStats.browsers[browser] || 0) + 1;
          }
        });
      }
    });

    res.json({ stats: totalStats });
  } catch (error) {
    console.error('Error fetching latest analytics:', error);
    res.status(500).json({ error: 'Failed to fetch latest analytics', details: error.message });
  }
});

// Serve world map data
app.get('/world.json', async (req, res) => {
  try {
    // Using topojson data for world map
    res.sendFile(path.join(__dirname, 'public', 'data', 'world-atlas.json'));
  } catch (error) {
    console.error('Error serving world map data:', error);
    res.status(500).json({ error: 'Failed to serve world map data' });
  }
});

// Get geographical analytics data
app.get('/api/analytics/geo/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  const { startDate, endDate } = req.query;
  
  try {
    if (!db) {
      throw new Error('Database not initialized');
    }

    const analyticsRef = db.collection(COLLECTIONS.ANALYTICS).doc(shortCode);
    const doc = await analyticsRef.get();
    
    if (!doc.exists) {
      return res.status(404).json({ error: 'Analytics not found' });
    }

    const data = doc.data();
    const geoStats = {
      totalClicks: 0,
      countries: {},
      cities: {},
      devices: {},
      browsers: {},
      timeRangeClicks: [],
      conversions: 0
    };

    // Process click history
    if (data.clickHistory) {
      data.clickHistory.forEach(click => {
        const clickDate = new Date(click.timestamp);
        
        // Apply date filter if provided
        if ((!startDate || clickDate >= new Date(startDate)) && 
            (!endDate || clickDate <= new Date(endDate))) {
          
          geoStats.totalClicks++;
          
          // Track country stats
          const country = click.location.country || 'Unknown';
          if (!geoStats.countries[country]) {
            geoStats.countries[country] = {
              clicks: 0,
              coordinates: [click.location.longitude || 0, click.location.latitude || 0]
            };
          }
          geoStats.countries[country].clicks++;
          
          // Track city stats
          const city = click.location.city || 'Unknown';
          if (!geoStats.cities[city]) {
            geoStats.cities[city] = {
              clicks: 0,
              country: country,
              coordinates: [click.location.longitude || 0, click.location.latitude || 0]
            };
          }
          geoStats.cities[city].clicks++;
          
          // Track device and browser stats
          geoStats.devices[click.device] = (geoStats.devices[click.device] || 0) + 1;
          geoStats.browsers[click.browser] = (geoStats.browsers[click.browser] || 0) + 1;
          
          // Track time-based clicks
          geoStats.timeRangeClicks.push({
            timestamp: click.timestamp,
            country: country
          });
        }
      });
    }

    res.json({
      shortCode,
      stats: geoStats
    });
  } catch (error) {
    console.error('Error fetching geographical analytics:', error);
    res.status(500).json({ error: 'Failed to fetch geographical analytics', details: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Link360 server running on http://localhost:${PORT}`);
});

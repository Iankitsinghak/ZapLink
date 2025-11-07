const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase-admin');
const path = require('path');

// GET geographic analytics data
router.post('/geographic', async (req, res) => {
  try {
    const { country = 'All', city = 'All', platform = 'All' } = req.body;
    let query = db.collection('clicks');

    if (country !== 'All') query = query.where('location.country', '==', country);
    if (city !== 'All') query = query.where('location.city', '==', city);
    if (platform !== 'All') query = query.where('platform', '==', platform);

    const snapshot = await query.get();
    const countryStats = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      const country = data.location?.country || 'Unknown';
      
      if (!countryStats[country]) {
        countryStats[country] = {
          name: country,
          count: 0,
          conversions: 0,
          revenue: 0
        };
      }
      
      countryStats[country].count += data.count || 1;
      countryStats[country].conversions += data.conversions || 0;
      countryStats[country].revenue += data.revenue || 0;
    });

    const data = Object.values(countryStats);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching geographic data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET views data over time
router.post('/views', async (req, res) => {
  try {
    const { country, city, platform, unit = 'day' } = req.body;
    let query = db.collection('clicks');

    if (country && country !== 'All') query = query.where('location.country', '==', country);
    if (city && city !== 'All') query = query.where('location.city', '==', city);
    if (platform && platform !== 'All') query = query.where('platform', '==', platform);

    const snapshot = await query.get();
    const timeStats = {};
    const now = new Date();

    // Initialize last 30 days
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      timeStats[dateStr] = {
        time: dateStr,
        visits: 0,
        visitors: 0
      };
    }

    // Aggregate data
    snapshot.forEach(doc => {
      const data = doc.data();
      const date = new Date(data.timestamp._seconds * 1000);
      const dateStr = date.toISOString().split('T')[0];
      
      if (timeStats[dateStr]) {
        timeStats[dateStr].visits += data.count || 1;
        timeStats[dateStr].visitors += 1; // Unique visitors approximation
      }
    });

    const data = Object.values(timeStats);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching views data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET all analytics with filters
router.get('/data', async (req, res) => {
  try {
    const { country = 'All', city = 'All', platform = 'All' } = req.query;
    let query = db.collection('clicks');

    // Apply filters
    if (country !== 'All') {
      query = query.where('location.country', '==', country);
    }
    if (city !== 'All') {
      query = query.where('location.city', '==', city);
    }
    if (platform !== 'All') {
      query = query.where('platform', '==', platform);
    }

    const snapshot = await query.get();
    const data = [];
    
    snapshot.forEach(doc => {
      const clickData = doc.data();
      data.push({
        id: doc.id,
        country: clickData.location?.country || 'Unknown',
        city: clickData.location?.city || 'Unknown',
        platform: clickData.platform || 'Direct',
        clicks: clickData.count || 1,
        conversions: clickData.conversions || 0,
        revenue: clickData.revenue || 0
      });
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching analytics data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET country statistics
router.get('/country-stats', async (req, res) => {
  try {
    const snapshot = await db.collection('clicks').get();
    const stats = {};

    snapshot.forEach(doc => {
      const clickData = doc.data();
      const country = clickData.location?.country || 'Unknown';
      
      if (!stats[country]) {
        stats[country] = {
          country,
          clicks: 0,
          conversions: 0,
          revenue: 0
        };
      }

      stats[country].clicks += clickData.count || 1;
      stats[country].conversions += clickData.conversions || 0;
      stats[country].revenue += clickData.revenue || 0;
    });

    const sorted = Object.values(stats).sort((a, b) => b.clicks - a.clicks);
    res.json({ success: true, data: sorted });
  } catch (error) {
    console.error('Error fetching country statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET city statistics by country
router.get('/city-stats/:country', async (req, res) => {
  try {
    const { country } = req.params;
    const query = db.collection('clicks').where('location.country', '==', country);
    const snapshot = await query.get();
    const stats = {};

    snapshot.forEach(doc => {
      const clickData = doc.data();
      const city = clickData.location?.city || 'Unknown';
      
      if (!stats[city]) {
        stats[city] = {
          city,
          clicks: 0,
          conversions: 0,
          revenue: 0
        };
      }

      stats[city].clicks += clickData.count || 1;
      stats[city].conversions += clickData.conversions || 0;
      stats[city].revenue += clickData.revenue || 0;
    });

    const sorted = Object.values(stats).sort((a, b) => b.clicks - a.clicks);
    res.json({ success: true, data: sorted });
  } catch (error) {
    console.error('Error fetching city statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET platform statistics
router.get('/platform-stats', async (req, res) => {
  try {
    const { country = 'All', city = 'All' } = req.query;
    let query = db.collection('clicks');

    if (country !== 'All') {
      query = query.where('location.country', '==', country);
    }
    if (city !== 'All') {
      query = query.where('location.city', '==', city);
    }

    const snapshot = await query.get();
    const stats = {};

    snapshot.forEach(doc => {
      const clickData = doc.data();
      const platform = clickData.platform || 'Direct';
      
      if (!stats[platform]) {
        stats[platform] = {
          name: platform,
          value: 0
        };
      }

      stats[platform].value += clickData.count || 1;
    });

    const sorted = Object.values(stats).sort((a, b) => b.value - a.value);
    res.json({ success: true, data: sorted });
  } catch (error) {
    console.error('Error fetching platform statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export CSV
router.get('/export-csv', async (req, res) => {
  try {
    const { country = 'All', city = 'All', platform = 'All' } = req.query;
    let query = db.collection('clicks');

    if (country !== 'All') {
      query = query.where('location.country', '==', country);
    }
    if (city !== 'All') {
      query = query.where('location.city', '==', city);
    }
    if (platform !== 'All') {
      query = query.where('platform', '==', platform);
    }

    const snapshot = await query.get();
    let csv = 'Country,City,Platform,Clicks,Conversions,Revenue\n';

    snapshot.forEach(doc => {
      const data = doc.data();
      const country = data.location?.country || 'Unknown';
      const city = data.location?.city || 'Unknown';
      const platform = data.platform || 'Direct';
      const clicks = data.count || 1;
      const conversions = data.conversions || 0;
      const revenue = data.revenue || 0;

      csv += `${country},${city},${platform},${clicks},${conversions},${revenue}\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="analytics_${new Date().toISOString().split('T')[0]}.csv"`);
    res.send(csv);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

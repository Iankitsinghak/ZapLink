// Initialize Firebase Auth globally
let auth;
let map;
let projection;
let path;
let svg;
let tooltip;
let width;
let height;
let zoom;
let currentZoomTransform = d3.zoomIdentity;
let worldData;
let markersGroup;
let countryGroup;

// Initialize the analytics dashboard
async function initializeAnalytics() {
    try {
        // Initialize Firebase
        auth = firebase.auth();
        
        // Create the map container
        width = document.getElementById('map-container').clientWidth;
        height = 500;

        // Set up the SVG
        svg = d3.select('#map-container')
            .append('svg')
            .attr('width', width)
            .attr('height', height);

        // Create a group for the map
        const g = svg.append('g');
        countryGroup = g.append('g');
        markersGroup = g.append('g');

        // Set up the projection
        projection = d3.geoMercator()
            .scale(width / 2 / Math.PI)
            .center([0, 20])
            .translate([width / 2, height / 2]);

        // Set up the path generator
        path = d3.geoPath().projection(projection);

        // Set up zoom behavior
        zoom = d3.zoom()
            .scaleExtent([1, 8])
            .on('zoom', (event) => {
                currentZoomTransform = event.transform;
                g.attr('transform', event.transform);
                if (markersGroup) {
                    updateMarkerSize();
                }
            });

        svg.call(zoom);

        // Create tooltip
        tooltip = d3.select('body').append('div')
            .attr('class', 'tooltip')
            .style('opacity', 0)
            .style('position', 'absolute')
            .style('background-color', 'white')
            .style('padding', '10px')
            .style('border', '1px solid #ddd')
            .style('border-radius', '4px')
            .style('pointer-events', 'none');

        // Load and draw the world map
        const response = await fetch('/world.json');
        const world = await response.json();
        worldData = topojson.feature(world, world.objects.countries);

        // Draw the map
        countryGroup.selectAll('path')
            .data(worldData.features)
            .enter()
            .append('path')
            .attr('d', path)
            .attr('class', 'country')
            .attr('fill', '#ccc')
            .attr('stroke', '#fff')
            .attr('stroke-width', '0.5px');

        // Fetch and display analytics data
        await fetchAndDisplayAnalytics();

        // Set up Socket.IO for real-time updates
        setupRealTimeUpdates();

    } catch (error) {
        console.error('Error initializing analytics:', error);
        showError('Failed to initialize analytics dashboard');
    }
}

// Fetch and display analytics data
async function fetchAndDisplayAnalytics() {
    try {
        const response = await fetch('/api/analytics/geo/latest', {
            headers: {
                'Authorization': `Bearer ${await auth.currentUser.getIdToken()}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch analytics data');
        }

        const data = await response.json();
        updateMapVisualization(data.stats);
        updateStatistics(data.stats);

    } catch (error) {
        console.error('Error fetching analytics:', error);
        showError('Failed to fetch analytics data');
    }
}

// Update map visualization with new data
function updateMapVisualization(stats) {
    // Clear existing markers
    markersGroup.selectAll('*').remove();

    // Add markers for cities
    Object.entries(stats.cities).forEach(([city, data]) => {
        if (data.coordinates && data.coordinates.length === 2) {
            const [long, lat] = data.coordinates;
            const projected = projection([long, lat]);

            if (projected) {
                const marker = markersGroup.append('circle')
                    .attr('cx', projected[0])
                    .attr('cy', projected[1])
                    .attr('r', Math.sqrt(data.clicks) * 3)
                    .attr('fill', '#ff4444')
                    .attr('opacity', 0.6)
                    .attr('stroke', '#fff')
                    .attr('stroke-width', '0.5px');

                // Add hover effects
                marker.on('mouseover', (event) => {
                    tooltip.transition()
                        .duration(200)
                        .style('opacity', .9);
                    tooltip.html(`
                        <strong>${city}</strong><br/>
                        Country: ${data.country}<br/>
                        Clicks: ${data.clicks}
                    `)
                    .style('left', (event.pageX + 10) + 'px')
                    .style('top', (event.pageY - 28) + 'px');
                })
                .on('mouseout', () => {
                    tooltip.transition()
                        .duration(500)
                        .style('opacity', 0);
                });
            }
        }
    });
}

// Update marker sizes based on zoom level
function updateMarkerSize() {
    markersGroup.selectAll('circle')
        .attr('r', function() {
            const baseRadius = parseFloat(d3.select(this).attr('data-base-radius'));
            return baseRadius / currentZoomTransform.k;
        });
}

// Update statistics display
function updateStatistics(stats) {
    // Update total clicks
    document.getElementById('total-clicks').textContent = stats.totalClicks;
    document.getElementById('total-conversions').textContent = stats.conversions;

    // Update top countries
    const topCountries = Object.entries(stats.countries)
        .sort(([, a], [, b]) => b.clicks - a.clicks)
        .slice(0, 5);

    const countryList = document.getElementById('top-countries');
    countryList.innerHTML = '';
    topCountries.forEach(([country, data]) => {
        const li = document.createElement('li');
        li.textContent = `${country}: ${data.clicks} clicks`;
        countryList.appendChild(li);
    });

    // Update device breakdown
    const deviceData = Object.entries(stats.devices);
    updatePieChart('device-chart', deviceData);

    // Update browser breakdown
    const browserData = Object.entries(stats.browsers);
    updatePieChart('browser-chart', browserData);
}

// Create/update pie charts
function updatePieChart(elementId, data) {
    const width = 200;
    const height = 200;
    const radius = Math.min(width, height) / 2;

    // Clear existing content
    d3.select(`#${elementId}`).selectAll('*').remove();

    const svg = d3.select(`#${elementId}`)
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2},${height / 2})`);

    const color = d3.scaleOrdinal(d3.schemeCategory10);

    const pie = d3.pie()
        .value(d => d[1]);

    const arc = d3.arc()
        .innerRadius(0)
        .outerRadius(radius);

    // Add the arcs
    const arcs = svg.selectAll('arc')
        .data(pie(data))
        .enter()
        .append('g');

    arcs.append('path')
        .attr('d', arc)
        .attr('fill', (d, i) => color(i))
        .attr('stroke', 'white')
        .style('stroke-width', '2px');

    // Add labels
    arcs.append('text')
        .attr('transform', d => `translate(${arc.centroid(d)})`)
        .attr('text-anchor', 'middle')
        .text(d => `${d.data[0]}: ${d.data[1]}`);
}

// Set up real-time updates via Socket.IO
function setupRealTimeUpdates() {
    const socket = io();

    socket.on('connect', () => {
        console.log('Connected to real-time updates');
        socket.emit('subscribe-global-analytics');
    });

    socket.on('analytics-update', (data) => {
        updateMapVisualization(data.stats);
        updateStatistics(data.stats);
    });

    socket.on('error', (error) => {
        console.error('Socket error:', error);
        showError('Real-time update connection lost');
    });
}

// Show error message
function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        setTimeout(() => {
            errorDiv.style.display = 'none';
        }, 5000);
    }
}

// Initialize analytics when the page loads
document.addEventListener('DOMContentLoaded', initializeAnalytics);
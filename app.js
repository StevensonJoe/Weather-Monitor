// Location definitions with coordinates
const LOCATIONS = {
    ports: [
        {
            name: "Felixstowe",
            lat: 51.9536,
            lon: 1.3511,
            type: "port"
        },
        {
            name: "Southampton",
            lat: 50.8998,
            lon: -1.4044,
            type: "port"
        },
        {
            name: "London Gateway",
            lat: 51.5025,
            lon: 0.4764,
            type: "port"
        }
    ],
    terminals: [
        {
            name: "Maritime Kegworth",
            lat: 52.8631,
            lon: -1.2750,
            type: "terminal"
        },
        {
            name: "Maritime Tamworth",
            lat: 52.6309,
            lon: -1.6953,
            type: "terminal"
        },
        {
            name: "Freightliner Leeds",
            lat: 53.7876,
            lon: -1.5476,
            type: "terminal"
        },
        {
            name: "Freightliner Birmingham",
            lat: 52.4862,
            lon: -1.8784,
            type: "terminal"
        }
    ]
};

// Wind speed alert thresholds (mph)
const THRESHOLDS = {
    amber: 30,
    orange: 35,
    red: 40
};

// Auto-refresh interval (5 minutes — keeps within 10k API calls/day over 24hrs)
const REFRESH_INTERVAL = 5 * 60 * 1000;

let refreshTimer = null;
let isRefreshing = false;

// Cache of last successful weather data per location
const weatherCache = {};

// Escape HTML to prevent XSS from injected content
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// Safely convert a value to a number, returning a fallback if invalid
function safeNumber(val, fallback) {
    const num = Number(val);
    return (Number.isFinite(num)) ? num : fallback;
}

// Convert km/h to mph
function kmhToMph(kmh) {
    return kmh * 0.621371;
}

// Convert metres to km
function metresToKm(m) {
    return m / 1000;
}

// Convert metres to miles
function metresToMiles(m) {
    return m / 1609.34;
}

// Get wind direction compass label from degrees
function getWindDirection(degrees) {
    if (degrees === null || degrees === undefined) return "N/A";
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    const index = Math.round(degrees / 22.5) % 16;
    return dirs[index];
}

// Get alert level for wind speed (mph)
function getWindAlertLevel(mph) {
    if (mph >= THRESHOLDS.red) return "red";
    if (mph >= THRESHOLDS.orange) return "orange";
    if (mph >= THRESHOLDS.amber) return "amber";
    return "green";
}

// Get CSS class for wind speed
function getWindClass(mph) {
    return "wind-" + getWindAlertLevel(mph);
}

// Get visibility classification
function getVisibilityClass(metres) {
    if (metres < 200) return "vis-fog";         // Dense fog
    if (metres < 1000) return "vis-poor";        // Fog
    if (metres < 4000) return "vis-moderate";    // Poor visibility
    return "vis-good";
}

// Get visibility description
function getVisibilityDesc(metres) {
    if (metres < 200) return "Dense Fog";
    if (metres < 1000) return "Fog";
    if (metres < 2000) return "Mist";
    if (metres < 4000) return "Poor";
    if (metres < 10000) return "Moderate";
    return "Good";
}

// Get alert badge label
function getAlertLabel(level) {
    switch (level) {
        case "amber": return "Caution";
        case "orange": return "Warning";
        case "red": return "Severe";
        default: return "";
    }
}

// Format a timestamp for display
function formatTime(date) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Calculate how long ago a timestamp was
function timeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "just now";
    if (diffMins === 1) return "1 min ago";
    if (diffMins < 60) return `${diffMins} mins ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs === 1) return "1 hour ago";
    return `${diffHrs} hours ago`;
}

// Fetch weather data for a single location from Open-Meteo (current + 7-day forecast in one call)
async function fetchWeather(location) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility&daily=wind_gusts_10m_max,wind_speed_10m_max&wind_speed_unit=mph&timezone=Europe%2FLondon&forecast_days=6&models=ukmo_seamless`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();

    if (!data || !data.current) {
        throw new Error("Invalid API response: missing current data");
    }

    const current = data.current;
    const daily = data.daily;

    const result = {
        windSpeed: Math.round(safeNumber(current.wind_speed_10m, 0)),
        windGust: Math.round(safeNumber(current.wind_gusts_10m, 0)),
        windDirection: safeNumber(current.wind_direction_10m, null),
        visibility: safeNumber(current.visibility, 0),
        time: current.time,
        forecast: null
    };

    // Only include forecast if daily data is valid
    if (daily && Array.isArray(daily.time) && daily.time.length > 0) {
        result.forecast = {
            dates: daily.time,
            maxGusts: (daily.wind_gusts_10m_max || []).map(v => safeNumber(v, 0)),
            maxWindSpeed: (daily.wind_speed_10m_max || []).map(v => safeNumber(v, 0))
        };
    }

    return result;
}

// ===== MAP =====
let weatherMap = null;
const mapMarkers = {};

// Color for alert level
function getAlertColor(level) {
    switch (level) {
        case "red": return "#e74c3c";
        case "orange": return "#e67e22";
        case "amber": return "#f39c12";
        default: return "#2ecc71";
    }
}

// Initialize the Leaflet map
function initMap() {
    weatherMap = L.map("weatherMap", {
        zoomControl: true,
        scrollWheelZoom: true
    }).setView([52.5, -0.5], 7);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 15
    }).addTo(weatherMap);

    // Create initial markers for all locations
    const allLocations = [...LOCATIONS.ports, ...LOCATIONS.terminals];
    for (const loc of allLocations) {
        const marker = L.circleMarker([loc.lat, loc.lon], {
            radius: 10,
            fillColor: "#6b8299",
            color: "#fff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.85
        }).addTo(weatherMap);

        marker.bindPopup(`<div class="map-popup-title">${loc.name}</div><div style="color:#6b8299;">Loading...</div>`);
        marker.bindTooltip(loc.name, {
            permanent: true,
            direction: "top",
            offset: [0, -12],
            className: "map-label"
        });

        mapMarkers[loc.name] = marker;
    }
}

// Update map markers with current weather data
function updateMapMarkers(allResults) {
    for (const { location, weather } of allResults) {
        const marker = mapMarkers[location.name];
        if (!marker || !weather) continue;

        const maxWind = Math.max(weather.windSpeed, weather.windGust);
        const level = getWindAlertLevel(maxWind);
        const color = getAlertColor(level);

        // Update marker color
        marker.setStyle({
            fillColor: color,
            color: "#fff",
            radius: level === "green" ? 10 : 13
        });

        // Build popup content
        const typeClass = location.type === "port" ? "type-port" : "type-terminal";
        const typeLabel = location.type === "port" ? "Port" : "Terminal";
        const visKm = metresToKm(weather.visibility);
        const visDesc = getVisibilityDesc(weather.visibility);

        let alertHtml = "";
        if (level !== "green") {
            alertHtml = `<div class="map-popup-alert ${level}">${getAlertLabel(level)}</div>`;
        }

        const popupHtml = `
            <div class="map-popup-title">
                ${location.name}
                <span class="map-popup-type ${typeClass}">${typeLabel}</span>
            </div>
            <div class="map-popup-row">
                <span class="map-popup-label">Wind:</span>
                <span class="map-popup-value" style="color:${color}">${weather.windSpeed} mph ${getWindDirection(weather.windDirection)}</span>
            </div>
            <div class="map-popup-row">
                <span class="map-popup-label">Gusts:</span>
                <span class="map-popup-value" style="color:${color}">${weather.windGust} mph</span>
            </div>
            <div class="map-popup-row">
                <span class="map-popup-label">Visibility:</span>
                <span class="map-popup-value">${visKm >= 1 ? visKm.toFixed(1) + " km" : Math.round(weather.visibility) + " m"} (${visDesc})</span>
            </div>
            ${alertHtml}
        `;

        marker.setPopupContent(popupHtml);
    }
}

// ===== CHARTS =====
// Store chart instances so we can update them without recreating
const chartInstances = {};

// Get bar color based on gust value
function getBarColor(value) {
    if (value >= THRESHOLDS.red) return "#e74c3c";
    if (value >= THRESHOLDS.orange) return "#e67e22";
    if (value >= THRESHOLDS.amber) return "#f39c12";
    return "#5dade2";
}

// Format date for chart labels (e.g. "Mon 20")
function formatChartDate(dateStr) {
    const date = new Date(dateStr + "T00:00:00");
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `${days[date.getDay()]} ${date.getDate()}`;
}

// Create or update a forecast chart embedded in the weather card
function renderForecastChart(location, forecast) {
    const chartId = `chart-${location.name.replace(/\s+/g, "-")}`;
    // Canvas should already exist inside the weather card
    const canvas = document.getElementById(chartId);
    if (!canvas) return;

    // Guard against empty forecast data
    if (!forecast.dates || forecast.dates.length === 0 || !forecast.maxGusts || forecast.maxGusts.length === 0) return;

    const labels = forecast.dates.map(formatChartDate);
    const gustData = forecast.maxGusts.map(v => Math.round(v));
    const barColors = gustData.map(getBarColor);
    const maxGust = Math.max(...forecast.maxGusts);

    // Chart y-axis max: at least 50, or 10 above the highest value
    const yMax = Math.max(50, Math.ceil((maxGust + 10) / 5) * 5);

    const chartConfig = {
        type: "bar",
        data: {
            labels: labels,
            datasets: [{
                label: "Max Gusts (mph)",
                data: gustData,
                backgroundColor: barColors,
                borderColor: barColors.map(c => c),
                borderWidth: 1,
                borderRadius: 4,
                barPercentage: 0.7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: "index"
            },
            scales: {
                x: {
                    ticks: { color: "#8a9bb5", font: { size: 9 } },
                    grid: { color: "rgba(44,74,110,0.3)" }
                },
                y: {
                    min: 0,
                    max: yMax,
                    ticks: {
                        color: "#8a9bb5",
                        font: { size: 9 },
                        stepSize: 10
                    },
                    grid: { color: "rgba(44,74,110,0.3)" }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#1a2a3a",
                    titleColor: "#fff",
                    bodyColor: "#e0e6ed",
                    borderColor: "#2c4a6e",
                    borderWidth: 1,
                    callbacks: {
                        label: function(ctx) {
                            const val = ctx.parsed.y;
                            const level = getWindAlertLevel(val);
                            const suffix = level !== "green" ? ` - ${getAlertLabel(level)}` : "";
                            return `Max Gust: ${val} mph${suffix}`;
                        }
                    }
                },
                annotation: {
                    annotations: {
                        amber: {
                            type: "line",
                            yMin: THRESHOLDS.amber,
                            yMax: THRESHOLDS.amber,
                            borderColor: "#f39c12",
                            borderWidth: 1,
                            borderDash: [4, 3],
                            label: {
                                display: true,
                                content: "30",
                                position: "end",
                                backgroundColor: "transparent",
                                color: "#f39c12",
                                font: { size: 8, weight: "bold" },
                                padding: 2
                            }
                        },
                        orange: {
                            type: "line",
                            yMin: THRESHOLDS.orange,
                            yMax: THRESHOLDS.orange,
                            borderColor: "#e67e22",
                            borderWidth: 1,
                            borderDash: [4, 3],
                            label: {
                                display: true,
                                content: "35",
                                position: "end",
                                backgroundColor: "transparent",
                                color: "#e67e22",
                                font: { size: 8, weight: "bold" },
                                padding: 2
                            }
                        },
                        red: {
                            type: "line",
                            yMin: THRESHOLDS.red,
                            yMax: THRESHOLDS.red,
                            borderColor: "#e74c3c",
                            borderWidth: 1,
                            borderDash: [4, 3],
                            label: {
                                display: true,
                                content: "40",
                                position: "end",
                                backgroundColor: "transparent",
                                color: "#e74c3c",
                                font: { size: 8, weight: "bold" },
                                padding: 2
                            }
                        }
                    }
                }
            }
        }
    };

    // Update existing chart or create new one
    if (chartInstances[chartId]) {
        const chart = chartInstances[chartId];
        chart.data.labels = labels;
        chart.data.datasets[0].data = gustData;
        chart.data.datasets[0].backgroundColor = barColors;
        chart.data.datasets[0].borderColor = barColors;
        chart.options.scales.y.max = yMax;
        chart.update("none"); // "none" skips animations for smoother refresh
    } else {
        chartInstances[chartId] = new Chart(canvas.getContext("2d"), chartConfig);
    }
}

// Get card ID for a location
function getCardId(location) {
    return `card-${location.name.replace(/\s+/g, "-")}`;
}

// Get cache key for a location
function getCacheKey(location) {
    return location.name;
}

// Build the inner HTML for a weather card
function buildCardContent(location, weather, isStale, staleTime) {
    const windLevel = getWindAlertLevel(weather.windSpeed);
    const gustLevel = getWindAlertLevel(weather.windGust);
    const highestLevel = getHighestAlert(windLevel, gustLevel);

    const typeClass = location.type === "port" ? "type-port" : "type-terminal";
    const typeLabel = location.type === "port" ? "Port" : "Terminal";

    const visKm = metresToKm(weather.visibility);
    const visClass = getVisibilityClass(weather.visibility);
    const visDesc = getVisibilityDesc(weather.visibility);

    const visPercent = Math.min((weather.visibility / 20000) * 100, 100);
    let visBarColor;
    if (weather.visibility < 200) visBarColor = "#e74c3c";
    else if (weather.visibility < 1000) visBarColor = "#e67e22";
    else if (weather.visibility < 4000) visBarColor = "#f39c12";
    else visBarColor = "#2ecc71";

    let alertBadge = "";
    if (highestLevel !== "green") {
        alertBadge = `<span class="alert-badge ${highestLevel}">${getAlertLabel(highestLevel)}</span>`;
    }

    // Stale data indicator
    let staleIndicator = "";
    if (isStale && staleTime) {
        const ago = timeAgo(staleTime);
        const timeStr = formatTime(staleTime);
        staleIndicator = `<span class="stale-indicator" title="Data may be outdated. Last successful update: ${timeStr} (${ago}). API rate limit was reached.">&#x25cf;</span>`;
    }

    return {
        highestLevel,
        html: `
        ${alertBadge}
        ${staleIndicator}
        <div class="card-header">
            <div>
                <div class="location-name">${location.name}</div>
            </div>
            <span class="location-type ${typeClass}">${typeLabel}</span>
        </div>
        <div class="metrics">
            <div class="metric">
                <div class="metric-label">Wind Speed</div>
                <div class="metric-value ${getWindClass(weather.windSpeed)}">${weather.windSpeed}</div>
                <div class="metric-unit">mph</div>
                <div class="wind-direction">${getWindDirection(weather.windDirection)}</div>
            </div>
            <div class="metric">
                <div class="metric-label">Gusts</div>
                <div class="metric-value ${getWindClass(weather.windGust)}">${weather.windGust}</div>
                <div class="metric-unit">mph</div>
            </div>
            <div class="metric">
                <div class="metric-label">Visibility</div>
                <div class="metric-value ${visClass}">${visKm >= 1 ? visKm.toFixed(1) : (weather.visibility).toFixed(0)}</div>
                <div class="metric-unit">${visKm >= 1 ? "km" : "m"}</div>
            </div>
        </div>
        <div class="card-footer">
            <div class="visibility-bar">
                <div class="visibility-fill" style="width: ${visPercent}%; background: ${visBarColor};"></div>
            </div>
            <span class="visibility-label">${visDesc}</span>
        </div>
        <div class="forecast-section">
            <div class="forecast-section-label">6-Day Max Gusts</div>
            <div class="inline-chart-container">
                <canvas id="chart-${location.name.replace(/\s+/g, "-")}"></canvas>
            </div>
        </div>
    `
    };
}

// Build error card content
function buildErrorContent(location, error) {
    const typeClass = location.type === "port" ? "type-port" : "type-terminal";
    const typeLabel = location.type === "port" ? "Port" : "Terminal";

    return `
        <div class="card-header">
            <div>
                <div class="location-name">${location.name}</div>
            </div>
            <span class="location-type ${typeClass}">${typeLabel}</span>
        </div>
        <div class="error-message">Unable to load weather data.<br><small>${escapeHtml(String(error))}</small></div>
    `;
}

// Create the initial empty card shell (used once on first load)
function createCardShell(location) {
    const card = document.createElement("div");
    card.className = "weather-card";
    card.id = getCardId(location);

    const typeClass = location.type === "port" ? "type-port" : "type-terminal";
    const typeLabel = location.type === "port" ? "Port" : "Terminal";

    card.innerHTML = `
        <div class="card-header">
            <div>
                <div class="location-name">${location.name}</div>
            </div>
            <span class="location-type ${typeClass}">${typeLabel}</span>
        </div>
        <div class="metrics">
            <div class="metric">
                <div class="metric-label">Wind Speed</div>
                <div class="metric-value">&mdash;</div>
                <div class="metric-unit">mph</div>
                <div class="wind-direction">&mdash;</div>
            </div>
            <div class="metric">
                <div class="metric-label">Gusts</div>
                <div class="metric-value">&mdash;</div>
                <div class="metric-unit">mph</div>
            </div>
            <div class="metric">
                <div class="metric-label">Visibility</div>
                <div class="metric-value">&mdash;</div>
                <div class="metric-unit">&mdash;</div>
            </div>
        </div>
        <div class="card-footer">
            <div class="visibility-bar">
                <div class="visibility-fill" style="width: 0%; background: #6b8299;"></div>
            </div>
            <span class="visibility-label">Loading...</span>
        </div>
        <div class="forecast-section">
            <div class="forecast-section-label">6-Day Max Gusts</div>
            <div class="inline-chart-container">
                <canvas id="chart-${location.name.replace(/\s+/g, "-")}"></canvas>
            </div>
        </div>
    `;
    return card;
}

// Update a card in-place with a fade transition
function updateCard(location, weather, error, isStale, staleTime, onComplete) {
    const card = document.getElementById(getCardId(location));
    if (!card) return;

    // Destroy existing chart before replacing innerHTML
    const chartId = `chart-${location.name.replace(/\s+/g, "-")}`;
    if (chartInstances[chartId]) {
        chartInstances[chartId].destroy();
        delete chartInstances[chartId];
    }

    // Fade out
    card.classList.add("updating");

    setTimeout(() => {
        if (weather) {
            const { highestLevel, html } = buildCardContent(location, weather, isStale, staleTime);
            card.innerHTML = html;

            // Update card alert class
            card.className = "weather-card";
            if (isStale) {
                card.classList.add("stale");
            }
            if (highestLevel !== "green") {
                card.classList.add(`alert-${highestLevel}`);
            }
        } else {
            card.innerHTML = buildErrorContent(location, error);
            card.className = "weather-card";
        }

        // Fade back in
        card.classList.add("updated");
        card.classList.remove("updating");

        // Render chart after DOM is updated
        if (onComplete) onComplete();

        setTimeout(() => {
            card.classList.remove("updated");
        }, 400);
    }, 200);
}

// Compare alert levels
function getHighestAlert(...levels) {
    const order = { red: 3, orange: 2, amber: 1, green: 0 };
    let highest = "green";
    for (const level of levels) {
        if ((order[level] || 0) > (order[highest] || 0)) {
            highest = level;
        }
    }
    return highest;
}

// Update alert banner
function updateAlertBanner(allResults) {
    const banner = document.getElementById("alertBanner");
    const alerts = [];

    for (const { location, weather } of allResults) {
        if (!weather) continue;

        const windLevel = getWindAlertLevel(weather.windSpeed);
        const gustLevel = getWindAlertLevel(weather.windGust);
        const highest = getHighestAlert(windLevel, gustLevel);

        if (highest !== "green") {
            const maxSpeed = Math.max(weather.windSpeed, weather.windGust);
            const isGust = weather.windGust > weather.windSpeed;
            alerts.push({
                name: location.name,
                level: highest,
                speed: maxSpeed,
                isGust: isGust
            });
        }
    }

    if (alerts.length === 0) {
        banner.classList.add("hidden");
        banner.innerHTML = "";
        return;
    }

    // Sort by severity (highest first)
    const order = { red: 3, orange: 2, amber: 1 };
    alerts.sort((a, b) => (order[b.level] || 0) - (order[a.level] || 0));

    banner.classList.remove("hidden");
    banner.innerHTML = `
        <span class="alert-label">&#x26a0; ACTIVE ALERTS:</span>
        ${alerts.map(a => `
            <span class="alert-item">
                ${a.name}: ${a.speed} mph ${a.isGust ? "(gusts)" : "(sustained)"} - ${getAlertLabel(a.level)}
            </span>
        `).join("")}
    `;

    if (alerts.some(a => a.level === "red")) {
        document.title = "\u26a0\ufe0f SEVERE ALERT - UK Port Weather Monitor";
    } else if (alerts.some(a => a.level === "orange")) {
        document.title = "\u26a0\ufe0f WARNING - UK Port Weather Monitor";
    } else {
        document.title = "UK Port & Terminal Weather Monitor";
    }
}

let isInitialized = false;

// Build the initial card layout (called once)
function initializeCards() {
    const portsGrid = document.getElementById("portsGrid");
    const terminalsGrid = document.getElementById("terminalsGrid");

    for (const loc of LOCATIONS.ports) {
        portsGrid.appendChild(createCardShell(loc));
    }
    for (const loc of LOCATIONS.terminals) {
        terminalsGrid.appendChild(createCardShell(loc));
    }

    // Initialize the map
    initMap();

    // Add summary card to ports grid
    const summaryCard = document.createElement("div");
    summaryCard.className = "weather-card summary-card";
    summaryCard.id = "summaryCard";
    summaryCard.innerHTML = `
        <div class="card-header">
            <div><div class="location-name">Conditions Summary</div></div>
            <span class="location-type type-summary">OVERVIEW</span>
        </div>
        <div class="summary-loading">Loading data...</div>
    `;
    portsGrid.appendChild(summaryCard);
}

// Update the summary card with current conditions across all locations
function updateSummaryCard(allResults) {
    const card = document.getElementById("summaryCard");
    if (!card || allResults.length === 0) return;

    // Find worst wind
    let worstWind = { name: "", speed: 0, gust: 0 };
    // Find worst visibility
    let worstVis = { name: "", visibility: Infinity };
    // Track all locations with alerts
    const windAlerts = [];
    const visIssues = [];

    for (const { location, weather } of allResults) {
        if (!weather) continue;

        // Wind
        const maxWind = Math.max(weather.windSpeed, weather.windGust);
        if (maxWind > worstWind.gust) {
            worstWind = { name: location.name, speed: weather.windSpeed, gust: weather.windGust };
        }
        const windLevel = getWindAlertLevel(maxWind);
        if (windLevel !== "green") {
            windAlerts.push({ name: location.name, level: windLevel, speed: maxWind });
        }

        // Visibility
        if (weather.visibility < worstVis.visibility) {
            worstVis = { name: location.name, visibility: weather.visibility };
        }
        if (weather.visibility < 4000) {
            visIssues.push({
                name: location.name,
                visibility: weather.visibility,
                desc: getVisibilityDesc(weather.visibility)
            });
        }
    }

    // Build hazard items
    const items = [];

    // Overall status
    const overallWindLevel = windAlerts.length > 0
        ? windAlerts.reduce((worst, a) => {
            const order = { red: 3, orange: 2, amber: 1 };
            return (order[a.level] || 0) > (order[worst.level] || 0) ? a : worst;
        }, windAlerts[0]).level
        : "green";

    const hasVisIssues = visIssues.length > 0;

    let statusClass, statusText;
    if (overallWindLevel === "red") {
        statusClass = "status-red";
        statusText = "Severe Disruption Likely";
    } else if (overallWindLevel === "orange") {
        statusClass = "status-orange";
        statusText = "Potential Disruption";
    } else if (overallWindLevel === "amber" || hasVisIssues) {
        statusClass = "status-amber";
        statusText = "Caution Advised";
    } else {
        statusClass = "status-green";
        statusText = "All Clear";
    }

    // Worst wind
    const worstWindLevel = getWindAlertLevel(worstWind.gust);
    items.push(`
        <div class="summary-item">
            <span class="summary-icon">&#x1f4a8;</span>
            <div class="summary-detail">
                <div class="summary-detail-label">Highest Wind</div>
                <div class="summary-detail-value ${getWindClass(worstWind.gust)}">${worstWind.name}: ${worstWind.gust} mph gusts</div>
            </div>
        </div>
    `);

    // Worst visibility
    const worstVisDesc = getVisibilityDesc(worstVis.visibility);
    const worstVisKm = metresToKm(worstVis.visibility);
    const worstVisClass = getVisibilityClass(worstVis.visibility);
    items.push(`
        <div class="summary-item">
            <span class="summary-icon">&#x1f32b;</span>
            <div class="summary-detail">
                <div class="summary-detail-label">Lowest Visibility</div>
                <div class="summary-detail-value ${worstVisClass}">${worstVis.name}: ${worstVisKm >= 1 ? worstVisKm.toFixed(1) + " km" : Math.round(worstVis.visibility) + " m"} (${worstVisDesc})</div>
            </div>
        </div>
    `);

    // Fog / visibility warnings
    if (visIssues.length > 0) {
        const fogNames = visIssues.map(v => `${v.name} (${v.desc})`).join(", ");
        items.push(`
            <div class="summary-item summary-warning">
                <span class="summary-icon">&#x26a0;</span>
                <div class="summary-detail">
                    <div class="summary-detail-label">Visibility Hazard</div>
                    <div class="summary-detail-value">${fogNames}</div>
                    <div class="summary-detail-note">May affect vessel navigation, crane ops & road transport</div>
                </div>
            </div>
        `);
    }

    // Wind alerts
    if (windAlerts.length > 0) {
        const alertNames = windAlerts
            .sort((a, b) => b.speed - a.speed)
            .map(a => `${a.name} (${a.speed} mph)`)
            .join(", ");
        items.push(`
            <div class="summary-item summary-warning">
                <span class="summary-icon">&#x26a0;</span>
                <div class="summary-detail">
                    <div class="summary-detail-label">Wind Alert</div>
                    <div class="summary-detail-value">${alertNames}</div>
                    <div class="summary-detail-note">May affect crane operations, stacking & vessel berthing</div>
                </div>
            </div>
        `);
    }

    // All clear messages when no issues
    if (windAlerts.length === 0 && visIssues.length === 0) {
        items.push(`
            <div class="summary-item">
                <span class="summary-icon">&#x2705;</span>
                <div class="summary-detail">
                    <div class="summary-detail-label">Operations</div>
                    <div class="summary-detail-value" style="color: #2ecc71;">No weather-related disruptions expected</div>
                </div>
            </div>
        `);
    }

    // Count locations with good conditions
    const goodCount = allResults.filter(r => {
        if (!r.weather) return false;
        const maxW = Math.max(r.weather.windSpeed, r.weather.windGust);
        return getWindAlertLevel(maxW) === "green" && r.weather.visibility >= 4000;
    }).length;

    card.innerHTML = `
        <div class="card-header">
            <div><div class="location-name">Conditions Summary</div></div>
            <span class="location-type type-summary">OVERVIEW</span>
        </div>
        <div class="summary-status ${statusClass}">
            <span class="summary-status-dot"></span>
            ${statusText}
        </div>
        <div class="summary-items">
            ${items.join("")}
        </div>
        <div class="summary-footer">
            ${goodCount}/${allResults.length} locations reporting normal conditions
        </div>
    `;
}

// Stagger API calls to avoid hitting per-second rate limits
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Load all weather data (updates cards in-place after first load)
async function loadAllWeather() {
    // Prevent overlapping refresh cycles
    if (isRefreshing) return;
    isRefreshing = true;

    if (!isInitialized) {
        initializeCards();
        isInitialized = true;
    }

    const allLocations = [...LOCATIONS.ports, ...LOCATIONS.terminals];
    const allResults = [];

    // Stagger requests slightly (500ms apart) to avoid per-second rate limits
    for (const location of allLocations) {
        const cacheKey = getCacheKey(location);

        try {
            const weather = await fetchWeather(location);
            // Success — update cache
            weatherCache[cacheKey] = {
                weather: weather,
                fetchedAt: new Date()
            };
            const forecast = weather.forecast;
            updateCard(location, weather, null, false, null, () => {
                if (forecast) renderForecastChart(location, forecast);
            });
            allResults.push({ location, weather });
        } catch (err) {
            // Failed — fall back to cached data if available
            const cached = weatherCache[cacheKey];
            if (cached) {
                const cachedForecast = cached.weather.forecast;
                updateCard(location, cached.weather, null, true, cached.fetchedAt, () => {
                    if (cachedForecast) renderForecastChart(location, cachedForecast);
                });
                allResults.push({ location, weather: cached.weather });
            } else {
                // No cache, show error (first load failure)
                updateCard(location, null, err.message, false, null);
            }
        }

        // Small delay between requests to be kind to the API
        await delay(500);
    }

    // Update alert banner, summary card, and map
    updateAlertBanner(allResults);
    updateSummaryCard(allResults);
    updateMapMarkers(allResults);

    // Update timestamp
    const now = new Date();
    document.getElementById("lastUpdated").textContent =
        `Last updated: ${formatTime(now)}`;

    isRefreshing = false;
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    loadAllWeather();

    // Auto-refresh every 5 minutes
    refreshTimer = setInterval(loadAllWeather, REFRESH_INTERVAL);
});

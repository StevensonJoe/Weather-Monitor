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

// Cache of last successful weather data per location
const weatherCache = {};

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
    const current = data.current;
    const daily = data.daily;

    return {
        windSpeed: Math.round(current.wind_speed_10m),
        windGust: Math.round(current.wind_gusts_10m),
        windDirection: current.wind_direction_10m,
        visibility: current.visibility,
        time: current.time,
        forecast: {
            dates: daily.time,
            maxGusts: daily.wind_gusts_10m_max,
            maxWindSpeed: daily.wind_speed_10m_max
        }
    };
}

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

    // Destroy existing chart and create new one
    if (chartInstances[chartId]) {
        chartInstances[chartId].destroy();
    }
    chartInstances[chartId] = new Chart(canvas.getContext("2d"), chartConfig);
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
        <div class="error-message">Unable to load weather data.<br><small>${error}</small></div>
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
}

// Stagger API calls to avoid hitting per-second rate limits
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Load all weather data (updates cards in-place after first load)
async function loadAllWeather() {
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

    // Update alert banner (uses whatever data we have, fresh or cached)
    updateAlertBanner(allResults);

    // Update timestamp
    const now = new Date();
    document.getElementById("lastUpdated").textContent =
        `Last updated: ${formatTime(now)}`;
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    loadAllWeather();

    // Auto-refresh every 5 minutes
    refreshTimer = setInterval(loadAllWeather, REFRESH_INTERVAL);
});

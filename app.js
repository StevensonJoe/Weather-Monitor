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

// Auto-refresh interval (2 minutes)
const REFRESH_INTERVAL = 2 * 60 * 1000;

let refreshTimer = null;

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

// Fetch weather data for a single location from Open-Meteo
async function fetchWeather(location) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility&wind_speed_unit=mph&timezone=Europe%2FLondon`;

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const current = data.current;

    return {
        windSpeed: Math.round(current.wind_speed_10m),
        windGust: Math.round(current.wind_gusts_10m),
        windDirection: current.wind_direction_10m,
        visibility: current.visibility, // metres
        time: current.time
    };
}

// Get card ID for a location
function getCardId(location) {
    return `card-${location.name.replace(/\s+/g, "-")}`;
}

// Build the inner HTML for a weather card
function buildCardContent(location, weather) {
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

    return {
        highestLevel,
        html: `
        ${alertBadge}
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
    `;
    return card;
}

// Update a card in-place with a fade transition
function updateCard(location, weather, error) {
    const card = document.getElementById(getCardId(location));
    if (!card) return;

    // Fade out
    card.classList.add("updating");

    setTimeout(() => {
        if (weather) {
            const { highestLevel, html } = buildCardContent(location, weather);
            card.innerHTML = html;

            // Update card alert class
            card.className = "weather-card";
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

    // Play notification sound for new severe alerts
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

// Load all weather data (updates cards in-place after first load)
async function loadAllWeather() {
    if (!isInitialized) {
        initializeCards();
        isInitialized = true;
    }

    const allLocations = [...LOCATIONS.ports, ...LOCATIONS.terminals];
    const allResults = [];

    // Fetch all in parallel
    const promises = allLocations.map(async (location) => {
        try {
            const weather = await fetchWeather(location);
            return { location, weather, error: null };
        } catch (err) {
            return { location, weather: null, error: err.message };
        }
    });

    const results = await Promise.all(promises);

    for (const result of results) {
        const { location, weather, error } = result;
        updateCard(location, weather, error);
        if (weather) {
            allResults.push({ location, weather });
        }
    }

    // Update alert banner
    updateAlertBanner(allResults);

    // Update timestamp
    const now = new Date();
    document.getElementById("lastUpdated").textContent =
        `Last updated: ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
    loadAllWeather();

    // Auto-refresh every 10 minutes
    refreshTimer = setInterval(loadAllWeather, REFRESH_INTERVAL);

    // Manual refresh button
    document.getElementById("refreshBtn").addEventListener("click", () => {
        loadAllWeather();
    });
});

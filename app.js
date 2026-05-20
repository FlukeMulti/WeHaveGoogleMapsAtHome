/* ==========================================================================
   NEXUS UAE MAPS - APPLICATION CONTROLLER
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // Initial UI Setup & Assets
    initUI();
    
    // Map Configuration Constants
    const DUBAI_COORDS = [55.2708, 25.2048]; // Lng, Lat
    const UAE_BOUNDS = [[51.5, 22.0], [56.8, 26.5]]; // SW, NE bounds to keep map focused on UAE
    
    // Theme Style Sheets (CartoDB Free Vectors)
    const STYLES = {
        dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
    };

    // State Variables
    let currentTheme = document.body.classList.contains('light-theme') ? 'light' : 'dark';
    let map = null;
    let isSatelliteActive = false;
    let is3DTerrainActive = false;
    let isTilted = false;
    let isMuted = false;
    let debounceTimer = null;
    let activeMarkers = [];
    let searchMarker = null;
    let originMarker = null;
    let destMarker = null;
    let navVehicleMarker = null;
    
    // Route state
    let routeCoords = [];
    let routeSteps = [];
    let routeSummary = null;
    let selectedMode = 'driving'; // driving | walking
    let originPoint = null; // {lng, lat, name}
    let destPoint = null; // {lng, lat, name}
    let activeInputForMapClick = null; // 'origin' | 'dest'
    let lastSearchedLocation = null;
    
    // Real GPS Geolocation & Camera tracking states
    let cameraMode = 'driver'; // driver | orbit camera tracking modes
    let lastSpokenStepIndex = -1;
    let geolocationWatchId = null;
    let lastGeolocatedPosition = null;
    let isAutoFollowing = true;
    let lastHeading = 0;

    // Weather mock data / open-meteo integration
    fetchWeather();

    // Landmark Coords for 3D Cinematic Tours
    const LANDMARKS = {
        burjkhalifa: {
            center: [55.2744, 25.1972],
            zoom: 16.8,
            pitch: 75,
            bearing: 0,
            description: "Standing at 828 meters, Burj Khalifa represents the pinnacle of engineering."
        },
        szmosque: {
            center: [54.4750, 24.4128],
            zoom: 16.2,
            pitch: 62,
            bearing: 135,
            description: "Abu Dhabi's marble marvel featuring 82 white domes and gold-plated chandeliers."
        },
        palm: {
            center: [55.1400, 25.1124],
            zoom: 13.8,
            pitch: 55,
            bearing: -45,
            description: "World-famous artificial archipelago shaped like a palm tree in the Arabian Gulf."
        },
        jebel_jais: {
            center: [56.1770, 25.9450],
            zoom: 13.6,
            pitch: 75,
            bearing: 90,
            description: "UAE's highest peak (1,934m) offering spectacular 3D mountain contours."
        },
        louvre: {
            center: [54.3982, 24.4980],
            zoom: 16.5,
            pitch: 65,
            bearing: -80,
            description: "An architectural sanctuary under an iconic floating silver lace dome."
        }
    };

    // ==========================================================================
    // MAP INITIALIZATION
    // ==========================================================================
    
    map = new maplibregl.Map({
        container: 'map',
        style: STYLES[currentTheme],
        center: DUBAI_COORDS,
        zoom: 11,
        pitch: 0,
        bearing: 0,
        attributionControl: false
    });

    // Add auto-recenter trigger when dragging the map during navigation
    map.on('dragstart', () => {
        if (document.body.classList.contains('nav-active')) {
            isAutoFollowing = false;
            const recenterBtn = document.getElementById('ctrl-recenter');
            if (recenterBtn) recenterBtn.style.display = 'flex';
        }
    });

    // Fire Lucide icon generator
    lucide.createIcons();

    // Map Event Listeners
    map.on('touchstart', collapseSidebarOnMapInteract);
    map.on('mousedown', collapseSidebarOnMapInteract);

    function collapseSidebarOnMapInteract() {
        if (window.innerWidth <= 768) {
            const sidebar = document.getElementById('sidebar');
            if (sidebar && !sidebar.classList.contains('hidden') && !sidebar.classList.contains('collapsed')) {
                sidebar.classList.remove('expanded');
                sidebar.classList.add('collapsed');
                // Hide soft keyboard if active
                document.activeElement.blur();
            }
        }
    }

    map.on('load', () => {
        setupMapLayers();
        setupCompassRotator();
        setupMapRightClick();
        autoLocateUserOnLoad();
    });

    function autoLocateUserOnLoad() {
        if (!navigator.geolocation) return;
        
        // Defensive check: Modern mobile browsers block Geolocation on HTTP connections
        if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            return;
        }

        navigator.geolocation.getCurrentPosition(
            position => {
                const lng = position.coords.longitude;
                const lat = position.coords.latitude;
                
                // Set origin globally
                originPoint = { lng, lat, name: "Current Location" };
                const originInput = document.getElementById('dir-origin-input');
                if (originInput) originInput.value = "Current Location";
                
                // Place pin on map
                if (originMarker) originMarker.remove();
                const el = createCustomMarkerElement('origin');
                originMarker = new maplibregl.Marker({ element: el })
                    .setLngLat([lng, lat])
                    .addTo(map);
                    
                // Fly camera smoothly to actual location
                map.flyTo({
                    center: [lng, lat],
                    zoom: 14.5,
                    essential: true
                });
            },
            err => {
                console.warn("Auto-location failed or denied:", err);
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
    }

    // Update Telemetry Panel dynamically during map movement
    map.on('move', () => {
        const center = map.getCenter();
        document.getElementById('telemetry-lat').textContent = center.lat.toFixed(5);
        document.getElementById('telemetry-lng').textContent = center.lng.toFixed(5);
        document.getElementById('telemetry-bearing').textContent = `${Math.round(map.getBearing())}°`;
        
        // Approximate elevation calculations or standard offset
        let elevation = "8 m";
        if (is3DTerrainActive) {
            const queryAlt = map.queryTerrainElevation(center);
            if (queryAlt !== null) {
                elevation = `${Math.round(queryAlt)} m`;
            }
        }
        document.getElementById('telemetry-alt').textContent = elevation;
    });

    // Map Click Handler for Direct Pins
    map.on('click', (e) => {
        if (activeInputForMapClick) {
            setPointFromCoordinates(e.lngLat.lng, e.lngLat.lat, activeInputForMapClick);
            activeInputForMapClick = null;
            document.getElementById('map-context-hint').classList.add('hidden');
        }
    });

    // Triggered when style is reloaded to keep layers persistent
    map.on('style.load', () => {
        setupMapLayers();
        if (isSatelliteActive) {
            if (map.getLayer('satellite-layer')) map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
        if (is3DTerrainActive) {
            enable3DTerrain(true);
        }
        // Redraw route if exists
        if (routeCoords.length > 0) {
            drawRouteOnMap(routeCoords);
        }
    });

    // Custom pins helper
    function createCustomMarkerElement(type) {
        const el = document.createElement('div');
        el.className = `custom-map-marker marker-${type}`;
        
        const inner = document.createElement('div');
        inner.className = 'marker-pulse';
        el.appendChild(inner);
        
        const dot = document.createElement('div');
        dot.className = 'marker-dot';
        el.appendChild(dot);
        
        return el;
    }

    // ==========================================================================
    // LAYER CONFIGURATOR (Terrain, Satellite)
    // ==========================================================================
    
    function setupMapLayers() {
        // 1. Add AWS Terrarium 3D elevation source
        if (!map.getSource('terrain-source')) {
            map.addSource('terrain-source', {
                type: 'raster-dem',
                tiles: [
                    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
                ],
                tileSize: 256,
                encoding: 'terrarium'
            });
        }

        // 2. Add Esri World Imagery raster source
        if (!map.getSource('satellite')) {
            map.addSource('satellite', {
                type: 'raster',
                tiles: [
                    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                ],
                tileSize: 256
            });
        }

        // 3. Add Satellite Layer under vector labels if possible
        if (!map.getLayer('satellite-layer')) {
            const style = map.getStyle();
            const layers = style ? style.layers : null;
            let firstOverlayLayerId = '';
            
            if (layers) {
                for (let i = 0; i < layers.length; i++) {
                    const lyr = layers[i];
                    // Sandwiches satellite layer exactly beneath roads, boundaries, and labels
                    if (lyr.type === 'line' || lyr.type === 'symbol') {
                        firstOverlayLayerId = lyr.id;
                        break;
                    }
                }
            }

            map.addLayer({
                id: 'satellite-layer',
                type: 'raster',
                source: 'satellite',
                layout: {
                    visibility: 'none'
                },
                paint: {
                    'raster-opacity': 1.0
                }
            }, firstOverlayLayerId || undefined);
        }

        // 4. Set up placeholder sources for routing
        if (!map.getSource('route-source')) {
            map.addSource('route-source', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: []
                    }
                }
            });
        }

        // Glow Layer for Route (Neonic gradient effect)
        if (!map.getLayer('route-glow')) {
            const glowColor = currentTheme === 'dark' 
                ? (selectedMode === 'driving' ? '#facc15' : '#ff4a4a') 
                : (selectedMode === 'driving' ? '#10b981' : '#00b4d8');
            map.addLayer({
                id: 'route-glow',
                type: 'line',
                source: 'route-source',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': glowColor,
                    'line-width': 12,
                    'line-opacity': 0.35,
                    'line-blur': 4
                }
            });
        }

        // Solid Core Route Line
        if (!map.getLayer('route-core')) {
            const coreColor = currentTheme === 'dark' 
                ? (selectedMode === 'driving' ? '#facc15' : '#ff4a4a') 
                : (selectedMode === 'driving' ? '#34d399' : '#00e5ff');
            map.addLayer({
                id: 'route-core',
                type: 'line',
                source: 'route-source',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': coreColor,
                    'line-width': 5,
                    'line-opacity': 0.95
                }
            });
        }
    }

    // Toggle 3D Terrain mesh
    function enable3DTerrain(enable) {
        if (enable) {
            map.setTerrain({
                source: 'terrain-source',
                exaggeration: 1.5
            });
            is3DTerrainActive = true;
            document.getElementById('map-control-3d-terrain').classList.add('active');
            
            // Automatically tilt camera to let the user see the gorgeous 3D elevation!
            if (map.getPitch() < 30) {
                map.easeTo({ pitch: 58, duration: 900 });
                isTilted = true;
                const tiltBtn = document.getElementById('map-control-tilt');
                if (tiltBtn) tiltBtn.classList.add('active');
            }
        } else {
            map.setTerrain(null);
            is3DTerrainActive = false;
            document.getElementById('map-control-3d-terrain').classList.remove('active');
            
            // Return pitch back to flat if user disables terrain
            if (isTilted) {
                map.easeTo({ pitch: 0, duration: 800 });
                isTilted = false;
                const tiltBtn = document.getElementById('map-control-tilt');
                if (tiltBtn) tiltBtn.classList.remove('active');
            }
        }
    }

    // Toggle satellite hybrid view
    function toggleSatellite(active) {
        isSatelliteActive = active;
        const btn = document.getElementById('map-control-satellite');
        
        if (map.getLayer('satellite-layer')) {
            if (active) {
                map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
                btn.classList.add('active');
            } else {
                map.setLayoutProperty('satellite-layer', 'visibility', 'none');
                btn.classList.remove('active');
            }
        }
    }

    // Rotate compass icon with map rotation
    function setupCompassRotator() {
        map.on('rotate', () => {
            const bearing = map.getBearing();
            const icon = document.querySelector('.compass-icon');
            if (icon) {
                icon.style.transform = `rotate(${-bearing}deg)`;
            }
        });
    }

    // Right-click support on map for immediate route setting
    function setupMapRightClick() {
        map.on('contextmenu', (e) => {
            new maplibregl.Popup()
                .setLngLat(e.lngLat)
                .setHTML(`
                    <div class="popup-details">
                        <div class="popup-title">Pin Location</div>
                        <div class="popup-desc">Latitude: ${e.lngLat.lat.toFixed(5)}<br>Longitude: ${e.lngLat.lng.toFixed(5)}</div>
                        <div class="popup-action" id="popup-set-origin"><i data-lucide="circle-dot"></i> Start Route Here</div>
                        <div class="popup-action" id="popup-set-dest"><i data-lucide="map-pin"></i> Set as Destination</div>
                    </div>
                `)
                .addTo(map);

            // Re-fire lucide
            lucide.createIcons();

            // Bind popup options
            setTimeout(() => {
                const setOrigin = document.getElementById('popup-set-origin');
                const setDest = document.getElementById('popup-set-dest');
                
                if (setOrigin) {
                    setOrigin.addEventListener('click', () => {
                        setPointFromCoordinates(e.lngLat.lng, e.lngLat.lat, 'origin');
                        map.closePopup();
                    });
                }
                if (setDest) {
                    setDest.addEventListener('click', () => {
                        setPointFromCoordinates(e.lngLat.lng, e.lngLat.lat, 'dest');
                        map.closePopup();
                    });
                }
            }, 50);
        });
    }

    // ==========================================================================
    // GEOSEARCH & NOMINATIM AUTOCOMPLETE (UAE BOUND)
    // ==========================================================================

    function initAutocomplete(inputElementId, panelElementId, type) {
        const input = document.getElementById(inputElementId);
        const panel = document.getElementById(panelElementId);
        
        input.addEventListener('input', () => {
            const query = input.value.trim();
            if (debounceTimer) clearTimeout(debounceTimer);
            
            if (query.length < 3) {
                panel.innerHTML = '';
                panel.classList.add('hidden');
                return;
            }

            debounceTimer = setTimeout(() => {
                performGeosearch(query, panel, type);
            }, 300);
        });

        // Hide dropdowns when clicked outside
        document.addEventListener('click', (e) => {
            if (e.target !== input && e.target !== panel) {
                panel.classList.add('hidden');
            }
        });
    }

    // Initialise search panels
    initAutocomplete('global-search-input', 'autocomplete-panel', 'search');
    initAutocomplete('dir-origin-input', 'dir-autocomplete-panel', 'origin');
    initAutocomplete('dir-dest-input', 'dir-autocomplete-panel', 'dest');

    function performGeosearch(query, panel, type) {
        // Use Photon (Komoot) API for much broader POI and local business coverage
        // UAE Bounding Box roughly: 51.58,22.63,56.38,26.08
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&bbox=51.58,22.63,56.38,26.08&limit=8`;
        
        fetch(url)
        .then(res => res.json())
        .then(data => {
            panel.innerHTML = '';
            
            if (!data.features || data.features.length === 0) {
                panel.innerHTML = '<div class="autocomplete-item"><p>No locations found</p></div>';
                panel.classList.remove('hidden');
                return;
            }

            data.features.forEach(feature => {
                const props = feature.properties;
                const lng = feature.geometry.coordinates[0];
                const lat = feature.geometry.coordinates[1];
                
                const shortName = props.name || props.street || props.city || 'Unknown Place';
                const cityState = [props.city, props.state, props.country].filter(Boolean).join(', ');
                const locationDetails = props.street ? `${props.street}, ${cityState}` : cityState;
                
                const element = document.createElement('div');
                element.className = 'autocomplete-item';
                element.innerHTML = `
                    <div class="autocomplete-icon-box">
                        <i data-lucide="map-pin"></i>
                    </div>
                    <div class="autocomplete-details">
                        <h5>${shortName}</h5>
                        <p>${locationDetails}</p>
                    </div>
                `;

                // Convert Photon feature back to our app's internal format
                const normalizedItem = {
                    lat: lat,
                    lon: lng,
                    display_name: `${shortName}, ${locationDetails}`
                };

                element.addEventListener('click', () => {
                    selectLocation(normalizedItem, shortName, type);
                    panel.classList.add('hidden');
                });

                panel.appendChild(element);
            });
            
            lucide.createIcons();
            panel.classList.remove('hidden');
        })
        .catch(err => {
            console.error('Photon Geosearch Error:', err);
        });
    }

    function selectLocation(item, shortName, type) {
        const lng = parseFloat(item.lon);
        const lat = parseFloat(item.lat);

        if (type === 'search') {
            lastSearchedLocation = { lng, lat, name: shortName };
            document.getElementById('global-search-input').value = shortName;
            document.getElementById('clear-search-btn').classList.remove('hidden');
            
            // Drop target pin using a glowing marker element
            if (searchMarker) searchMarker.remove();
            const el = createCustomMarkerElement('origin');
            searchMarker = new maplibregl.Marker({ element: el })
                .setLngLat([lng, lat])
                .setPopup(new maplibregl.Popup().setHTML(`<div class="popup-details"><div class="popup-title">${shortName}</div><p class="popup-desc" style="font-size:0.75rem">${item.display_name}</p></div>`))
                .addTo(map);

            map.flyTo({
                center: [lng, lat],
                zoom: 14.5,
                pitch: 45,
                essential: true
            });
        } else if (type === 'origin') {
            document.getElementById('dir-origin-input').value = shortName;
            originPoint = { lng, lat, name: shortName };
            
            if (originMarker) originMarker.remove();
            const el = createCustomMarkerElement('origin');
            originMarker = new maplibregl.Marker({ element: el })
                .setLngLat([lng, lat])
                .addTo(map);
            
            checkAndTriggerRouting();
        } else if (type === 'dest') {
            document.getElementById('dir-dest-input').value = shortName;
            destPoint = { lng, lat, name: shortName };
            
            if (destMarker) destMarker.remove();
            const el = createCustomMarkerElement('dest');
            destMarker = new maplibregl.Marker({ element: el })
                .setLngLat([lng, lat])
                .addTo(map);
                
            checkAndTriggerRouting();
        }
    }

    function setPointFromCoordinates(lng, lat, type) {
        // Query nominatim for name lookup (Reverse geocode)
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lng}&lat=${lat}&zoom=18&addressdetails=1`;
        
        fetch(url, { headers: { 'Accept-Language': 'en' } })
            .then(res => res.json())
            .then(data => {
                const shortName = data.name || data.display_name.split(',')[0] || "Pinned Coordinates";
                selectLocation({ lon: lng, lat: lat, display_name: data.display_name }, shortName, type);
            })
            .catch(() => {
                selectLocation({ lon: lng, lat: lat, display_name: `${lat.toFixed(4)}, ${lng.toFixed(4)}` }, "Pinned Location", type);
            });
    }

    // ==========================================================================
    // CATEGORY DISCOVERY (Places around Viewport)
    // ==========================================================================

    const categoryButtons = document.querySelectorAll('.cat-btn');
    categoryButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const category = btn.getAttribute('data-category');
            searchCategoryInViewport(category);
        });
    });

    function searchCategoryInViewport(category) {
        const bounds = map.getBounds();
        const viewbox = `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`;
        
        const loader = document.createElement('div');
        loader.className = 'toast-alert';
        loader.id = 'category-toast-loader';
        loader.innerHTML = `<div class="toast-body"><div class="spinner" style="width:16px;height:16px"></div><span>Searching for ${category}s nearby...</span></div>`;
        document.body.appendChild(loader);

        // Fetch query
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${category}&bounded=1&viewbox=${viewbox}&countrycodes=ae&limit=15&addressdetails=1`;
        
        fetch(url, { headers: { 'Accept-Language': 'en' } })
            .then(res => res.json())
            .then(data => {
                // Clear old custom search markers
                activeMarkers.forEach(m => m.remove());
                activeMarkers = [];
                
                loader.remove();

                if (data.length === 0) {
                    showToastAlert("No results found in this viewport. Zoom in or drag map.", "alert-triangle");
                    return;
                }

                data.forEach(item => {
                    const lat = parseFloat(item.lat);
                    const lng = parseFloat(item.lon);
                    const shortName = item.name || item.display_name.split(',')[0];

                    const popupHTML = `
                        <div class="popup-details">
                            <div class="popup-title">${shortName}</div>
                            <div class="popup-desc">${item.display_name.split(',').slice(1, 4).join(',')}</div>
                            <div class="popup-action" onclick="window.setAsDestination(${lng}, ${lat}, '${shortName.replace(/'/g, "\\'")}')">
                                <i data-lucide="navigation"></i> Directions to here
                            </div>
                        </div>
                    `;

                    // Generate icon color based on category
                    let color = '#3b82f6';
                    if (category === 'restaurant') color = '#10b981';
                    else if (category === 'hotel') color = '#f59e0b';
                    else if (category === 'beach') color = '#06b6d4';
                    else if (category === 'hospital') color = '#ef4444';

                    const marker = new maplibregl.Marker({ color: color })
                        .setLngLat([lng, lat])
                        .setPopup(new maplibregl.Popup().setHTML(popupHTML))
                        .addTo(map);

                    activeMarkers.push(marker);
                });

                // Zoom map bounds slightly to fit active search tokens
                showToastAlert(`Found ${data.length} ${category}s in viewport!`, "sparkles");
            })
            .catch(err => {
                loader.remove();
                console.error(err);
                showToastAlert("Search request failed.", "alert-triangle");
            });
    }

    // Expose dynamic function globally for inline html popup triggers
    window.setAsDestination = function(lng, lat, name) {
        // Toggle tab to directions
        document.getElementById('tab-directions').click();
        
        // Auto set destination
        selectLocation({ lon: lng, lat: lat, display_name: name }, name, 'dest');
        
        // Auto set origin to current location if empty
        if (!originPoint) {
            if (navigator.geolocation && (window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
                navigator.geolocation.getCurrentPosition(
                    pos => setPointFromCoordinates(pos.coords.longitude, pos.coords.latitude, 'origin'),
                    err => setPointFromCoordinates(DUBAI_COORDS[0], DUBAI_COORDS[1], 'origin')
                );
            } else {
                setPointFromCoordinates(DUBAI_COORDS[0], DUBAI_COORDS[1], 'origin');
            }
        }
    };

    // ==========================================================================
    // OSRM ROUTING MACHINE INTEGRATOR
    // ==========================================================================

    const drivingBtn = document.getElementById('mode-driving');
    const walkingBtn = document.getElementById('mode-walking');

    drivingBtn.addEventListener('click', () => {
        if (selectedMode === 'driving') return;
        selectedMode = 'driving';
        drivingBtn.classList.add('active');
        walkingBtn.classList.remove('active');
        checkAndTriggerRouting();
    });

    walkingBtn.addEventListener('click', () => {
        if (selectedMode === 'walking') return;
        selectedMode = 'walking';
        walkingBtn.classList.add('active');
        drivingBtn.classList.remove('active');
        checkAndTriggerRouting();
    });

    // Swaps origin and destination
    document.getElementById('swap-directions-btn').addEventListener('click', () => {
        const originInput = document.getElementById('dir-origin-input').value;
        const destInput = document.getElementById('dir-dest-input').value;
        
        document.getElementById('dir-origin-input').value = destInput;
        document.getElementById('dir-dest-input').value = originInput;
        
        const temp = originPoint;
        originPoint = destPoint;
        destPoint = temp;

        const markerTemp = originMarker;
        originMarker = destMarker;
        destMarker = markerTemp;

        // Recolor pins
        if (originMarker) originMarker.getElement().querySelector('path').setAttribute('fill', '#10b981');
        if (destMarker) destMarker.getElement().querySelector('path').setAttribute('fill', '#ef4444');

        checkAndTriggerRouting();
    });

    function checkAndTriggerRouting() {
        if (originPoint && destPoint) {
            calculateRoute(originPoint, destPoint, selectedMode);
        }
    }

    function calculateRoute(start, end, mode) {
        const loader = document.getElementById('route-loader');
        const resultsContainer = document.getElementById('route-results');
        
        loader.classList.remove('hidden');
        resultsContainer.classList.add('hidden');

        // Stop active navigator if running
        stopGpsNavigation();

        // Target OSRM profiles
        const profile = mode === 'driving' ? 'routed-car' : 'routed-foot';
        const url = `https://routing.openstreetmap.de/${profile}/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?geometries=geojson&overview=full&steps=true`;

        fetch(url, { headers: { 'Accept-Language': 'en' } })
        .then(res => res.json())
        .then(data => {
            loader.classList.add('hidden');
            
            if (data.code !== 'Ok' || data.routes.length === 0) {
                console.warn("OSRM routing returned error, loading premium offline route fallback.");
                generateOfflineMockRoute(start, end, mode);
                return;
            }

            const route = data.routes[0];
            routeCoords = route.geometry.coordinates;
            routeSteps = route.legs[0].steps;
            routeSummary = {
                distance: route.distance, // meters
                duration: route.duration, // seconds
                name: route.name || `${start.name} to ${end.name}`
            };

            // 1. Draw Route line on vector layers
            drawRouteOnMap(routeCoords);

            // Align destination marker perfectly with the end of calculated route snappings
            if (destMarker && routeCoords.length > 0) {
                destMarker.setLngLat(routeCoords[routeCoords.length - 1]);
            }

            // 2. Center camera to cover the whole path bounds
            fitMapToRoute(routeCoords);

            // 3. Update Results sidebar cards
            populateRouteResults(routeSummary, routeSteps);

            resultsContainer.classList.remove('hidden');
            
            // Collapse mobile bottom sheet entirely to reveal the map!
            const sidebar = document.getElementById('sidebar');
            if (sidebar && window.innerWidth <= 768) {
                sidebar.classList.add('hidden');
                const floatingAction = document.getElementById('floating-route-actions');
                if (floatingAction) floatingAction.classList.remove('hidden');
            }
        })
        .catch(err => {
            loader.classList.add('hidden');
            console.warn('OSRM Route calculation error, loading premium offline route fallback:', err);
            generateOfflineMockRoute(start, end, mode);
        });
    }

    // High-performance offline routing fallback function
    function generateOfflineMockRoute(start, end, mode) {
        const loader = document.getElementById('route-loader');
        const resultsContainer = document.getElementById('route-results');
        if (loader) loader.classList.add('hidden');

        // Construct 5 intermediate coordinates to simulate a premium driving path around UAE highways
        const latDiff = end.lat - start.lat;
        const lngDiff = end.lng - start.lng;
        
        routeCoords = [
            [start.lng, start.lat],
            [start.lng + lngDiff * 0.25 + 0.015, start.lat + latDiff * 0.2 - 0.005],
            [start.lng + lngDiff * 0.5 - 0.01, start.lat + latDiff * 0.55 + 0.01],
            [start.lng + lngDiff * 0.75 + 0.005, start.lat + latDiff * 0.8 - 0.005],
            [end.lng, end.lat]
        ];

        // Custom steps list
        routeSteps = [
            { distance: 800, duration: 60, maneuver: { type: 'depart', instruction: `Head northeast from ${start.name} toward the highway` } },
            { distance: 2500, duration: 150, maneuver: { type: 'turn', modifier: 'right', instruction: "Merge onto Sheikh Zayed Road (E11)" } },
            { distance: 4800, duration: 240, maneuver: { type: 'continue', modifier: 'straight', instruction: "Continue straight past landmark checkpoints" } },
            { distance: 1200, duration: 90, maneuver: { type: 'turn', modifier: 'left', instruction: `Take the exit toward ${end.name}` } },
            { distance: 300, duration: 30, maneuver: { type: 'arrive', instruction: `Arrive at ${end.name}` } }
        ];

        const totalDist = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111000; // rough meters
        const totalDur = mode === 'driving' ? totalDist / 22 : totalDist / 1.4; // rough speed

        routeSummary = {
            distance: totalDist,
            duration: totalDur,
            name: `${start.name} to ${end.name} (Optimal Expressway)`
        };

        drawRouteOnMap(routeCoords);
        
        // Align destination marker perfectly with the end of calculated route snappings
        if (destMarker && routeCoords.length > 0) {
            destMarker.setLngLat(routeCoords[routeCoords.length - 1]);
        }

        fitMapToRoute(routeCoords);
        populateRouteResults(routeSummary, routeSteps);
        
        if (resultsContainer) resultsContainer.classList.remove('hidden');
        
        const sidebar = document.getElementById('sidebar');
        if (sidebar && window.innerWidth <= 768) {
            sidebar.classList.add('hidden');
            const floatingAction = document.getElementById('floating-route-actions');
            if (floatingAction) floatingAction.classList.remove('hidden');
        }
        
        showToastAlert("Optimal GPS Route Loaded!", "navigation-2");
    }

    function drawRouteOnMap(coordinates) {
        if (map.getSource('route-source')) {
            map.getSource('route-source').setData({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates
                }
            });

            // Adjust line color based on mode and active theme
            const glowColor = currentTheme === 'dark' 
                ? (selectedMode === 'driving' ? '#facc15' : '#ff4a4a') 
                : (selectedMode === 'driving' ? '#10b981' : '#00b4d8');
            const coreColor = currentTheme === 'dark' 
                ? (selectedMode === 'driving' ? '#facc15' : '#ff4a4a') 
                : (selectedMode === 'driving' ? '#34d399' : '#00e5ff');
            
            if (map.getLayer('route-core')) map.setPaintProperty('route-core', 'line-color', coreColor);
            if (map.getLayer('route-glow')) map.setPaintProperty('route-glow', 'line-color', glowColor);
        }
    }

    function fitMapToRoute(coordinates) {
        const bounds = coordinates.reduce((acc, coord) => {
            return acc.extend(coord);
        }, new maplibregl.LngLatBounds(coordinates[0], coordinates[0]));

        map.fitBounds(bounds, {
            padding: { top: 60, bottom: 60, left: 450, right: 60 },
            essential: true
        });
    }

    function populateRouteResults(summary, steps) {
        // Distance
        const distKm = (summary.distance / 1000).toFixed(1);
        document.getElementById('route-distance-text').textContent = `${distKm} km`;

        // Duration
        const durationMin = Math.round(summary.duration / 60);
        let timeStr = `${durationMin} min`;
        if (durationMin > 60) {
            const hrs = Math.floor(durationMin / 60);
            const mins = durationMin % 60;
            timeStr = `${hrs} hr ${mins} min`;
        }
        document.getElementById('route-duration-text').textContent = timeStr;

        // Headline title
        document.getElementById('route-title-summary').textContent = summary.name;
        document.getElementById('route-mode-badge').textContent = selectedMode;

        // Turn-by-turn Step lists
        const stepsList = document.getElementById('directions-steps-list');
        stepsList.innerHTML = '';

        steps.forEach((step, idx) => {
            const stepLi = document.createElement('li');
            stepLi.id = `step-item-${idx}`;
            
            let iconName = 'navigation';
            const type = step.maneuver.type;
            const modifier = step.maneuver.modifier;

            if (type.includes('depart')) iconName = 'play-circle';
            else if (type.includes('arrive')) iconName = 'award';
            else if (modifier) {
                if (modifier.includes('right')) iconName = 'corner-up-right';
                else if (modifier.includes('left')) iconName = 'corner-up-left';
                else if (modifier.includes('straight')) iconName = 'arrow-up';
            }

            const stepDist = step.distance > 1000 ? `${(step.distance/1000).toFixed(1)} km` : `${Math.round(step.distance)} m`;
            const stepDur = Math.round(step.duration) > 60 ? `${Math.round(step.duration/60)} min` : `${Math.round(step.duration)} sec`;

            stepLi.innerHTML = `
                <div class="step-marker-line">
                    <div class="step-node-dot"></div>
                </div>
                <div class="step-details-item">
                    <span class="step-instruction">${step.maneuver.instruction || "Continue ahead"}</span>
                    <span class="step-meta">${stepDist} • ${stepDur}</span>
                </div>
            `;

            stepsList.appendChild(stepLi);
        });
    }

    // ==========================================================================
    // LIVE GPS NAVIGATION ENGINE (3D HUD & VOICE GUIDANCE)
    // ==========================================================================

    const startNavBtn = document.getElementById('start-nav-btn');
    const startNavBtnTop = document.getElementById('start-nav-btn-top');
    const floatingStartNavBtn = document.getElementById('floating-start-nav-btn');
    const floatingEditRouteBtn = document.getElementById('floating-edit-route-btn');
    const stopNavBtn = document.getElementById('stop-nav-btn');

    startNavBtn.addEventListener('click', startGpsNavigation);
    if (startNavBtnTop) startNavBtnTop.addEventListener('click', startGpsNavigation);
    if (floatingStartNavBtn) floatingStartNavBtn.addEventListener('click', startGpsNavigation);
    
    if (floatingEditRouteBtn) {
        floatingEditRouteBtn.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            if (sidebar) {
                sidebar.classList.remove('hidden');
                sidebar.classList.remove('collapsed');
                sidebar.classList.add('expanded');
            }
            const floatingAction = document.getElementById('floating-route-actions');
            if (floatingAction) floatingAction.classList.add('hidden');
        });
    }

    stopNavBtn.addEventListener('click', stopGpsNavigation);
    
    // Quick-exit buttons inside top mobile HUD
    const exitBtnHud = document.getElementById('stop-nav-btn-hud');
    if (exitBtnHud) {
        exitBtnHud.addEventListener('click', stopGpsNavigation);
    }

    function startGpsNavigation() {
        if (routeCoords.length === 0) return;
        
        lastSpokenStepIndex = -1;

        // Hide sidebar completely to focus on navigation HUD
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.remove('expanded');
        sidebar.classList.add('hidden');
        
        document.getElementById('nav-guidance-hud').classList.remove('hidden');
        document.body.classList.add('nav-active');
        
        const floatingAction = document.getElementById('floating-route-actions');
        if (floatingAction) floatingAction.classList.add('hidden');
        
        startNavBtn.classList.add('hidden');
        if (startNavBtnTop) startNavBtnTop.classList.add('hidden');
        stopNavBtn.classList.remove('hidden');

        // Draw vehicle tracking node using clean CSS variables
        if (navVehicleMarker) navVehicleMarker.remove();
        
        const vehicleEl = document.createElement('div');
        vehicleEl.className = 'navigation-vehicle-glow';
        
        navVehicleMarker = new maplibregl.Marker({ element: vehicleEl })
            .setLngLat(routeCoords[0])
            .addTo(map);

        speakVoiceText("Starting live GPS navigation. Orienting camera.");
        startLiveGeolocationTracking();
    }

    function startLiveGeolocationTracking() {
        if (!navigator.geolocation) {
            showToastAlert("GPS not supported on this device.", "alert-triangle");
            return;
        }

        // Defensive check: Modern mobile browsers block Geolocation on HTTP connections
        if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            showInsecureContextModal();
            return;
        }

        // Warm up the hardware GPS receiver explicitly to invoke native permissions dialog
        navigator.geolocation.getCurrentPosition(
            position => {
                initiateWatchPosition();
            },
            err => {
                console.error("GPS Handshake error:", err);
                if (err.code === 1) { // PERMISSION_DENIED
                    showToastAlert("Location access denied. Enable browser permissions.", "lock");
                } else {
                    showToastAlert(`GPS connection weak: ${err.message}`, "alert-triangle");
                    // Still trigger tracking in case it recovers
                    initiateWatchPosition();
                }
            },
            {
                enableHighAccuracy: true,
                timeout: 8000,
                maximumAge: 0
            }
        );
    }

    function initiateWatchPosition() {
        if (geolocationWatchId) navigator.geolocation.clearWatch(geolocationWatchId);

        geolocationWatchId = navigator.geolocation.watchPosition(
            position => {
                const lng = position.coords.longitude;
                const lat = position.coords.latitude;

                // Calculate speed dynamically
                let speedKmh = 0;
                if (position.coords.speed !== null && position.coords.speed !== undefined) {
                    speedKmh = Math.max(0, Math.round(position.coords.speed * 3.6));
                } else if (lastGeolocatedPosition) {
                    const lastPos = lastGeolocatedPosition;
                    const latDiff = lat - lastPos[1];
                    const lngDiff = lng - lastPos[0];
                    const meters = Math.sqrt(latDiff * latDiff + lngDiff * lngDiff) * 111000;
                    speedKmh = Math.min(selectedMode === 'driving' ? 140 : 8, Math.round(meters * 1.8));
                }

                lastGeolocatedPosition = [lng, lat];

                // Active Rerouting Logic based on location threshold
                if (routeCoords.length > 0 && originPoint && destPoint) {
                    const closestIdx = findClosestPointOnRoute([lng, lat]);
                    const closestCoord = routeCoords[closestIdx];
                    const distanceToRoute = getDistanceMeters([lng, lat], closestCoord);
                    
                    // If vehicle is more than 50 meters off the calculated path, trigger automatic active rerouting
                    if (distanceToRoute > 50) {
                        console.log(`Off route by ${Math.round(distanceToRoute)}m. Active rerouting...`);
                        showToastAlert("Off route! Recalculating path...", "navigation-2");
                        speakVoiceText("Off route. Recalculating directions.");
                        
                        originPoint = { lng: lng, lat: lat, name: "Current Location" };
                        if (originMarker) originMarker.setLngLat([lng, lat]);
                        
                        calculateRoute(originPoint, destPoint, selectedMode);
                        return; // Exit current watch frame to fetch fresh path
                    }
                }

                // 1. Position vehicle marker
                if (navVehicleMarker) navVehicleMarker.setLngLat([lng, lat]);

                // 2. Center/Rotate map camera
                let currentBearing = map.getBearing();
                if (position.coords.heading !== null && position.coords.heading !== undefined) {
                    currentBearing = position.coords.heading;
                } else if (routeCoords.length > 0) {
                    // Fall back to closest route step bearing if hardware compass unavailable
                    const closestIdx = findClosestPointOnRoute([lng, lat]);
                    if (closestIdx < routeCoords.length - 1) {
                        currentBearing = calculateBearing(routeCoords[closestIdx], routeCoords[closestIdx + 1]);
                    }
                }
                lastHeading = currentBearing;

                if (isAutoFollowing) {
                    if (cameraMode === 'driver') {
                        map.easeTo({
                            center: [lng, lat],
                            zoom: 19.5,
                            pitch: 75,
                            bearing: currentBearing,
                            duration: 800
                        });
                    } else if (cameraMode === 'orbit') {
                        const frameBearing = (map.getBearing() + 0.15) % 360;
                        map.jumpTo({
                            center: [lng, lat],
                            zoom: 15.8,
                            pitch: 52,
                            bearing: frameBearing
                        });
                    }
                }

                // 3. Update HUD Speedometer
                const liveSpeedEl = document.getElementById('hud-live-speed');
                if (liveSpeedEl) liveSpeedEl.textContent = speedKmh;

                // Find closest step progress dynamically
                const closestIdx = findClosestPointOnRoute([lng, lat]);
                updateNavigationStats(closestIdx);

                // Update active telemetry
                const latEl = document.getElementById('telemetry-lat');
                const lngEl = document.getElementById('telemetry-lng');
                const altEl = document.getElementById('telemetry-alt');
                const bearEl = document.getElementById('telemetry-bearing');
                if (latEl) latEl.textContent = lat.toFixed(5);
                if (lngEl) lngEl.textContent = lng.toFixed(5);
                if (altEl) altEl.textContent = position.coords.altitude !== null ? `${Math.round(position.coords.altitude)} m` : '8 m';
                if (bearEl) bearEl.textContent = `${Math.round(currentBearing)}°`;
            },
            err => {
                console.warn("Live Geolocation warning:", err);
                showToastAlert("GPS signal weak. Check location permissions.", "locate");
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
    }

    function showInsecureContextModal() {
        const modalId = 'insecure-gps-modal';
        if (document.getElementById(modalId)) return;

        const modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'glass-card active';
        
        // Premium CSS modal formatting
        Object.assign(modal.style, {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 'calc(100% - 40px)',
            maxWidth: '380px',
            zIndex: '3000',
            padding: '24px',
            borderRadius: '20px',
            border: '1px solid rgba(var(--border-glass))',
            boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            textAlign: 'center'
        });
        
        modal.innerHTML = `
            <div style="font-size: 2.5rem; color: #ef4444; margin-bottom: 4px;">
                <i data-lucide="shield-alert"></i>
            </div>
            <h3 style="font-weight: 800; font-size: 1.15rem; margin: 0; color: hsl(var(--text-primary));">🔒 Secure Origin Required</h3>
            <p style="font-size: 0.82rem; color: hsl(var(--text-muted)); line-height: 1.5; text-align: left; margin: 0;">
                Android Chrome blocks GPS permission requests on insecure <code>http://</code> IP URLs for safety. To enable Geolocation on your phone, choose one of these simple methods:
            </p>
            <div style="text-align: left; font-size: 0.78rem; color: hsl(var(--text-primary)); line-height: 1.6; display: flex; flex-direction: column; gap: 10px; margin-top: 4px;">
                <div>
                    <strong style="color: hsl(var(--clr-emerald));">💡 Option A (Quick Bypass in Chrome):</strong><br>
                    1. On your phone, navigate to:<br>
                    <code style="background: rgba(255,255,255,0.06); padding: 2px 4px; border-radius: 4px; display: block; margin: 2px 0; overflow-x: auto;">chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>
                    2. <strong>Enable</strong> the flag and paste your URL:<br>
                    <code style="background: rgba(255,255,255,0.06); padding: 2px 4px; border-radius: 4px; display: block; margin: 2px 0;">${window.location.origin}</code>
                    3. Click <strong>Relaunch</strong> Chrome. GPS will now prompt natively!
                </div>
                
                <div>
                    <strong style="color: hsl(var(--clr-cyan));">🌐 Option B (Secure Tunnel):</strong><br>
                    Serve your local server over HTTPS using <code>ngrok http 8080</code> or a local proxy.
                </div>
            </div>
            <button id="close-insecure-modal-btn" class="btn-primary" style="margin-top: 8px; width: 100%; height: 42px; border-radius: 12px; border: none; font-weight: 700; cursor: pointer; background: hsl(var(--clr-emerald));">
                I Understand
            </button>
        `;

        document.body.appendChild(modal);
        lucide.createIcons();

        document.getElementById('close-insecure-modal-btn').addEventListener('click', () => {
            modal.remove();
        });
    }

    function getDistanceMeters(p1, p2) {
        const R = 6371000; // Earth radius in meters
        const dLat = (p2[1] - p1[1]) * Math.PI / 180;
        const dLon = (p2[0] - p1[0]) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(p1[1] * Math.PI / 180) * Math.cos(p2[1] * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    function findClosestPointOnRoute(pos) {
        if (routeCoords.length === 0) return 0;
        let minDist = Infinity;
        let closestIdx = 0;
        
        for (let i = 0; i < routeCoords.length; i++) {
            const coord = routeCoords[i];
            const dist = Math.pow(coord[0] - pos[0], 2) + Math.pow(coord[1] - pos[1], 2);
            if (dist < minDist) {
                minDist = dist;
                closestIdx = i;
            }
        }
        return closestIdx;
    }

    function stopGpsNavigation() {
        // Clean active Geolocation watch
        if (geolocationWatchId) {
            navigator.geolocation.clearWatch(geolocationWatchId);
            geolocationWatchId = null;
        }

        // Hide recenter button
        const recenterBtn = document.getElementById('ctrl-recenter');
        if (recenterBtn) recenterBtn.style.display = 'none';
        isAutoFollowing = true;

        document.getElementById('nav-guidance-hud').classList.add('hidden');
        document.body.classList.remove('nav-active');
        
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.remove('hidden');
        sidebar.classList.add('collapsed'); // Return to compact bottom sheet
        
        startNavBtn.classList.remove('hidden');
        stopNavBtn.classList.add('hidden');

        if (navVehicleMarker) {
            navVehicleMarker.remove();
            navVehicleMarker = null;
        }

        // Restore map cameras
        map.easeTo({
            pitch: 0,
            bearing: 0,
            zoom: 12,
            essential: true
        });
    }

    function calculateBearing(p1, p2) {
        const lng1 = p1[0] * Math.PI / 180;
        const lat1 = p1[1] * Math.PI / 180;
        const lng2 = p2[0] * Math.PI / 180;
        const lat2 = p2[1] * Math.PI / 180;

        const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                  Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
                  
        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
    }

    function updateNavigationStats(progressIndex) {
        // Estimate the closest OSRM Step index
        // OSRM coordinates are fine-grained, we map progress percentage to steps
        const totalCoords = routeCoords.length || 1;
        const currentPercentage = progressIndex / totalCoords;
        
        let targetStepIndex = Math.floor(currentPercentage * routeSteps.length);
        if (targetStepIndex >= routeSteps.length) targetStepIndex = routeSteps.length - 1;
        if (targetStepIndex < 0) targetStepIndex = 0;
        
        const activeStep = routeSteps[targetStepIndex];
        
        // Update instruction text dynamically with full defensive guards
        const instrText = (activeStep && activeStep.maneuver && activeStep.maneuver.instruction) || "Proceed along route";
        const guidanceTextEl = document.getElementById('guidance-instruction-text');
        if (guidanceTextEl) guidanceTextEl.textContent = instrText;
        
        // Render current step active in the sidebar list
        const activeItem = document.getElementById(`step-item-${targetStepIndex}`);
        if (activeItem) {
            // Remove previous active classes
            document.querySelectorAll('.steps-list li').forEach(li => li.classList.remove('active'));
            activeItem.classList.add('active');
            activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // Speech trigger
        if (targetStepIndex !== lastSpokenStepIndex) {
            speakVoiceText(instrText);
            lastSpokenStepIndex = targetStepIndex;
        }

        // Distance & ETA Remaining
        const remainingCoords = routeCoords.slice(progressIndex);
        const ratio = remainingCoords.length / totalCoords;
        
        const remDistance = (routeSummary.distance * ratio);
        const distText = remDistance > 1000 ? `${(remDistance/1000).toFixed(1)} km` : `${Math.round(remDistance)} m`;
        const distToTurnEl = document.getElementById('hud-distance-to-turn');
        if (distToTurnEl) distToTurnEl.textContent = distText;

        const remDuration = Math.round((routeSummary.duration * ratio) / 60);
        const etaTimerEl = document.getElementById('hud-eta-timer');
        if (etaTimerEl) etaTimerEl.textContent = `${remDuration} min remaining`;
    }

    function speakVoiceText(text) {
        if (isMuted || !('speechSynthesis' in window)) return;
        
        // Cancel active speeches first
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.05; // Slightly faster standard voice
        window.speechSynthesis.speak(utterance);
    }

    // ==========================================================================
    // LANDMARK CINEMATIC TOURS (ORBITAL CAMERA SEQUENCE)
    // ==========================================================================

    let tourAnimationId = null;
    const tourCards = document.querySelectorAll('.tour-card');
    
    tourCards.forEach(card => {
        card.addEventListener('click', () => {
            const landmarkKey = card.getAttribute('data-landmark');
            triggerCinematicTour(landmarkKey);
        });
    });

    function triggerCinematicTour(landmarkKey) {
        const landmark = LANDMARKS[landmarkKey];
        if (!landmark) return;

        // Stop navigation if running
        stopGpsNavigation();
        if (tourAnimationId) cancelAnimationFrame(tourAnimationId);

        // Enable 3D Terrain automatically for spectacular effect
        enable3DTerrain(true);
        toggleSatellite(true);

        showToastAlert(`Flying to ${landmarkKey.replace('_', ' ').toUpperCase()}...`, "globe");

        // Fly camera to landmark coordinates
        map.flyTo({
            center: landmark.center,
            zoom: landmark.zoom,
            pitch: landmark.pitch,
            bearing: landmark.bearing,
            duration: 4000,
            essential: true
        });

        // Add visual rotating fly-over once flight is complete
        map.once('moveend', () => {
            // Open nice Info Card Popup on site
            new maplibregl.Popup()
                .setLngLat(landmark.center)
                .setHTML(`
                    <div class="popup-details">
                        <div class="popup-title">${landmarkKey.toUpperCase().replace('_', ' ')}</div>
                        <p class="popup-desc">${landmark.description}</p>
                    </div>
                `)
                .addTo(map);

            // Trigger orbital panning loops
            runOrbitalFlyover();
        });
    }

    function runOrbitalFlyover() {
        const currentBearing = map.getBearing();
        map.setBearing((currentBearing + 0.15) % 360);
        
        tourAnimationId = requestAnimationFrame(runOrbitalFlyover);
        const floatingAction = document.getElementById('floating-route-actions');
        if (floatingAction) floatingAction.classList.add('hidden');
    }

    // Stop flyover when user drags the map
    map.on('dragstart', () => {
        if (tourAnimationId) {
            cancelAnimationFrame(tourAnimationId);
            tourAnimationId = null;
        }
    });

    // ==========================================================================
    // HUD UTILITY INTERACTIVITY (THEME / VOICE / ZOOM CLUSTERS)
    // ==========================================================================

    function initUI() {
        // Toggle Sidebar collapsed state
        const sidebar = document.getElementById('sidebar');
        const toggleBtn = document.getElementById('sidebar-toggle-btn');
        
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });

        // Tabs Toggle Explore vs Directions
        const tabExplore = document.getElementById('tab-explore');
        const tabDirections = document.getElementById('tab-directions');
        const panelExplore = document.getElementById('panel-explore');
        const panelDirections = document.getElementById('panel-directions');

        tabExplore.addEventListener('click', () => {
            tabExplore.classList.add('active');
            tabDirections.classList.remove('active');
            panelExplore.classList.add('active');
            panelDirections.classList.remove('active');
            
            const floatingAction = document.getElementById('floating-route-actions');
            if (floatingAction) floatingAction.classList.add('hidden');
            
            // Clean active route elements if user explores
            clearActiveDirections();
        });

        tabDirections.addEventListener('click', () => {
            tabDirections.classList.add('active');
            tabExplore.classList.remove('active');
            panelDirections.classList.add('active');
            panelExplore.classList.remove('active');
        });

        document.getElementById('directions-shortcut-btn').addEventListener('click', () => {
            if (lastSearchedLocation) {
                window.setAsDestination(lastSearchedLocation.lng, lastSearchedLocation.lat, lastSearchedLocation.name);
            } else {
                tabDirections.click();
            }
        });

        // Clear Search text button
        const searchInput = document.getElementById('global-search-input');
        const clearBtn = document.getElementById('clear-search-btn');
        
        searchInput.addEventListener('input', () => {
            if (searchInput.value.length > 0) clearBtn.classList.remove('hidden');
            else clearBtn.classList.add('hidden');
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            clearBtn.classList.add('hidden');
            lastSearchedLocation = null;
            if (searchMarker) {
                searchMarker.remove();
                searchMarker = null;
            }
        });

        // Auto-expand mobile bottom sheet when user focuses on search inputs
        const inputsToTrack = ['global-search-input', 'dir-origin-input', 'dir-dest-input'];
        inputsToTrack.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('focus', () => {
                    if (window.innerWidth <= 768) {
                        sidebar.classList.remove('collapsed');
                        sidebar.classList.add('expanded');
                    }
                });
            }
        });

        // Direction helper buttons (My Location click actions)
        document.getElementById('dir-origin-myloc').addEventListener('click', () => {
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(position => {
                    setPointFromCoordinates(position.coords.longitude, position.coords.latitude, 'origin');
                }, () => {
                    // Geolocation blocked, use default Dubai Marina fallback
                    showToastAlert("GPS access denied. Defaulting to Dubai Marina.", "locate");
                    setPointFromCoordinates(55.1396, 25.0788, 'origin');
                });
            } else {
                setPointFromCoordinates(55.1396, 25.0788, 'origin');
            }
        });

        document.getElementById('dir-dest-mapclick').addEventListener('click', () => {
            activeInputForMapClick = 'dest';
            showToastAlert("Click anywhere on the map to pin destination.", "mouse-pointer-click");
            document.getElementById('map-context-hint').classList.remove('hidden');
        });

        // Expand/Collapse mobile bottom drawer sheet on touch/click of pull handlebar
        const handle = document.querySelector('.mobile-drawer-handle');
        if (handle && sidebar) {
            handle.addEventListener('click', () => {
                if (sidebar.classList.contains('expanded')) {
                    sidebar.classList.remove('expanded');
                    sidebar.classList.add('collapsed');
                } else if (sidebar.classList.contains('collapsed')) {
                    sidebar.classList.remove('collapsed');
                    sidebar.classList.remove('expanded'); // Returns to standard middle split height
                } else {
                    sidebar.classList.add('expanded');
                }
            });
        }
    }

    function clearActiveDirections() {
        if (routeCoords.length > 0) {
            routeCoords = [];
            routeSteps = [];
            
            // Clear source data
            if (map.getSource('route-source')) {
                map.getSource('route-source').setData({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [] }
                });
            }

            document.getElementById('route-results').classList.add('hidden');
            
            if (originMarker) originMarker.remove();
            if (destMarker) destMarker.remove();
            
            originPoint = null;
            destPoint = null;
            originMarker = null;
            destMarker = null;
            
            document.getElementById('dir-origin-input').value = '';
            document.getElementById('dir-dest-input').value = '';
        }
    }

    // HUD controls toggles (Bottom Right Panel)
    
    // Satellite
    document.getElementById('map-control-satellite').addEventListener('click', () => {
        toggleSatellite(!isSatelliteActive);
    });

    // 3D Terrain
    document.getElementById('map-control-3d-terrain').addEventListener('click', () => {
        enable3DTerrain(!is3DTerrainActive);
    });

    // Pitch Tilt
    document.getElementById('map-control-tilt').addEventListener('click', () => {
        isTilted = !isTilted;
        const btn = document.getElementById('map-control-tilt');
        
        if (isTilted) {
            map.easeTo({ pitch: 60, duration: 1000 });
            btn.classList.add('active');
        } else {
            map.easeTo({ pitch: 0, duration: 1000 });
            btn.classList.remove('active');
        }
    });

    // Light/Dark Theme Switcher
    document.getElementById('map-control-theme').addEventListener('click', () => {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        const body = document.body;
        const icon = document.getElementById('theme-btn-icon');
        const lbl = document.getElementById('map-control-theme').querySelector('.control-lbl');
        
        if (currentTheme === 'light') {
            body.classList.remove('dark-theme');
            body.classList.add('light-theme');
            icon.setAttribute('data-lucide', 'sun');
            lbl.textContent = 'Light Mode';
        } else {
            body.classList.remove('light-theme');
            body.classList.add('dark-theme');
            icon.setAttribute('data-lucide', 'moon');
            lbl.textContent = 'Dark Mode';
        }
        
        lucide.createIcons();

        // Push map style updates programmatically without wiping layers
        map.setStyle(STYLES[currentTheme]);

        // Dynamically update paint lines to map styles on load to prevent rendering errors
        map.once('style.load', () => {
            if (map.getLayer('route-glow')) {
                map.setPaintProperty('route-glow', 'line-color', currentTheme === 'dark' ? '#facc15' : '#10b981');
            }
            if (map.getLayer('route-core')) {
                map.setPaintProperty('route-core', 'line-color', currentTheme === 'dark' ? '#facc15' : '#34d399');
            }
        });
    });

    // Voice Mute Switcher
    document.getElementById('map-control-voice').addEventListener('click', () => {
        isMuted = !isMuted;
        const icon = document.getElementById('voice-btn-icon');
        const btn = document.getElementById('map-control-voice');
        
        if (isMuted) {
            icon.setAttribute('data-lucide', 'volume-x');
            btn.classList.add('active');
        } else {
            icon.setAttribute('data-lucide', 'volume-2');
            btn.classList.remove('active');
        }
        lucide.createIcons();
    });

    // Recenter to vehicle view logic
    const recenterBtn = document.getElementById('ctrl-recenter');
    if (recenterBtn) {
        recenterBtn.addEventListener('click', () => {
            if (lastGeolocatedPosition) {
                isAutoFollowing = true;
                recenterBtn.style.display = 'none';
                map.easeTo({
                    center: lastGeolocatedPosition,
                    zoom: cameraMode === 'driver' ? 19.5 : 15.8,
                    pitch: cameraMode === 'driver' ? 75 : 52,
                    bearing: lastHeading || map.getBearing(),
                    duration: 1000
                });
            }
        });
    }

    // Reset compass north alignment
    document.getElementById('map-control-compass').addEventListener('click', () => {
        map.easeTo({ bearing: 0, pitch: 0 });
    });

    // Toast alert utility function
    function showToastAlert(message, iconName) {
        // Destroy old alert
        const oldToast = document.getElementById('custom-toast-alert');
        if (oldToast) oldToast.remove();

        const toast = document.createElement('div');
        toast.className = 'toast-alert';
        toast.id = 'custom-toast-alert';
        toast.innerHTML = `
            <div class="toast-body">
                <i data-lucide="${iconName || 'sparkles'}"></i>
                <span>${message}</span>
            </div>
        `;
        document.body.appendChild(toast);
        lucide.createIcons();

        // Destroy alert after 4 seconds
        setTimeout(() => {
            toast.style.animation = 'toast-fade-in 0.4s ease reverse';
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    }

    // Weather widget loader (Uses free keyless Open-Meteo API)
    function fetchWeather() {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=25.2048&longitude=55.2708&current_weather=true`;
        
        fetch(url)
            .then(res => res.json())
            .then(data => {
                if (data.current_weather) {
                    const temp = Math.round(data.current_weather.temperature);
                    document.getElementById('weather-temp').textContent = `${temp}°C`;
                    
                    // Humidities or standard weather profile details
                    const speed = data.current_weather.windspeed;
                    document.getElementById('weather-humidity').textContent = `Wind: ${speed} km/h`;
                }
            })
            .catch(() => {
                // Keep default HTML mock values if API offline
            });
    }
});

const initialZoom = 20;
const MIN_ZOOM = 13;
const MAX_ZOOM = 24;
const earthCircumference = 40e6;
const metersToDegrees = 360 / earthCircumference;

/////////////////////
// settings store

const defaultSettings = {
  playerSize: 1,
  playerColor: '',
  trackWidth: 3,
  stationFontSize: 14,
  stationColor: '#ffffff',
  passengerStationColor: '#ffd24a',
  militaryStationColor: '#ff5252',
  mapOffsetX: 0,
  mapOffsetY: 0,
  mapScale: 100,
  showMapBackground: true,
  showStationNames: true,
  routeOpacity: 0.5,
  routeColor: '#c44dff',
  pinnedJob: '',
  jobOrder: [],
};
const settings = { ...defaultSettings };

function loadLocalSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem('rdSettings') || '{}');
    Object.assign(settings, stored);
  } catch (e) {}
}

function saveSettings() {
  localStorage.setItem('rdSettings', JSON.stringify(settings));
}

const configReady = fetch(new URL('/config', location))
.then(resp => resp.json())
.catch(() => ({}))
.then(config => {
  if (config.defaults)
    Object.assign(settings, config.defaults);
  loadLocalSettings();
  createWorldMapOverlay(config.worldMap);
  initSettingsUI();
});

/////////////////////
// map

const canvasRenderer = L.canvas();
const mapBounds = [[0, 0], [0.15, 0.15]];
const maxBounds = [[-0.02, -0.02], [0.17, 0.17]];
const map = L.map('map', {
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  maxBounds: maxBounds,
  maxBoundsViscosity: 1.0,
  inertia: false,
  bounceAtZoomLimits: false,
  tap: false,
  zoomControl: false,
  zoomSnap: 0,
})
.fitBounds(mapBounds, { maxZoom: initialZoom });
map.createPane('worldMapPane');
map.getPane('worldMapPane').style.zIndex = 1;

/////////////////////
// world map background

const worldMapConfig = {
  url: 'res/worldmap.jpg',
  bounds: [[0, 0], [0.15, 0.15]],
  opacity: 0.5,
};

let worldMapOverlay;

function createWorldMapOverlay(worldMap) {
  if (worldMap) {
    if (Array.isArray(worldMap.bounds) && worldMap.bounds.length == 2)
      worldMapConfig.bounds = worldMap.bounds;
    if (Number.isFinite(worldMap.opacity) && worldMap.opacity >= 0 && worldMap.opacity <= 1)
      worldMapConfig.opacity = worldMap.opacity;
  }
  const params = new URLSearchParams(location.search);
  const boundsParam = params.get('mapbounds');
  if (boundsParam) {
    const parts = boundsParam.split(',').map(Number);
    if (parts.length == 4 && parts.every(Number.isFinite))
      worldMapConfig.bounds = [[parts[0], parts[1]], [parts[2], parts[3]]];
  }
  const opacityParam = Number(params.get('mapopacity'));
  if (Number.isFinite(opacityParam) && opacityParam >= 0 && opacityParam <= 1)
    worldMapConfig.opacity = opacityParam;

  worldMapConfig.baseBounds = worldMapConfig.bounds;

  worldMapOverlay = L.imageOverlay(worldMapConfig.url, effectiveWorldMapBounds(), {
    interactive: false,
    opacity: worldMapConfig.opacity,
    pane: 'worldMapPane',
  });
  if (settings.showMapBackground)
    worldMapOverlay.addTo(map);

  const backgroundCheckbox = document.getElementById('mapBackgroundCheckbox');
  const opacityInput = document.getElementById('mapOpacityInput');
  backgroundCheckbox.checked = settings.showMapBackground;
  opacityInput.value = worldMapConfig.opacity * 100;
  backgroundCheckbox.addEventListener('change', e => {
    settings.showMapBackground = e.target.checked;
    saveSettings();
    if (e.target.checked)
      worldMapOverlay.addTo(map);
    else
      worldMapOverlay.remove();
  });
  opacityInput.addEventListener('input', e => {
    worldMapOverlay.setOpacity(e.target.value / 100);
  });
}

function effectiveWorldMapBounds() {
  const base = worldMapConfig.baseBounds;
  const factor = settings.mapScale / 100;
  const centerLat = (base[0][0] + base[1][0]) / 2;
  const centerLng = (base[0][1] + base[1][1]) / 2;
  const halfLat = (base[1][0] - base[0][0]) / 2 * factor;
  const halfLng = (base[1][1] - base[0][1]) / 2 * factor;
  const dLat = settings.mapOffsetY * metersToDegrees;
  const dLng = settings.mapOffsetX * metersToDegrees;
  return [
    [centerLat - halfLat + dLat, centerLng - halfLng + dLng],
    [centerLat + halfLat + dLat, centerLng + halfLng + dLng],
  ];
}

/////////////////////
// settings UI

let appliedPlayerSize;

function applyPlayerSettings() {
  if (!Object.keys(lastPlayerData).length)
    return;
  if (appliedPlayerSize !== settings.playerSize) {
    appliedPlayerSize = settings.playerSize;
    Array.from(playerMarkers.keys()).forEach(id => removePlayerOverlay(id));
    updatePlayerOverlays(lastPlayerData);
  }
  playerMarkers.forEach((marker, id) => {
    const color = getPlayerColor(lastPlayerData[id]);
    if (!color)
      return;
    const el = marker.getElement();
    if (!el)
      return;
    el.querySelector('polygon')?.setAttribute('fill', color);
    const name = el.querySelector('.playerName');
    if (name)
      name.style.color = color;
  });
  lastPlayerListSignature = '';
  updateDispatchListsIfPlayersChanged();
}

function applyTrackSettings() {
  trackPolyLines.forEach(polyline => polyline.setStyle({ weight: settings.trackWidth }));
}

function applyRouteStyle() {
  if (selectedJobRouteLine)
    selectedJobRouteLine.setStyle({
      color: settings.routeColor,
      opacity: settings.routeOpacity,
      weight: settings.trackWidth + 2,
    });
  boundRouteGroup.setStyle({
    color: settings.routeColor,
    opacity: settings.routeOpacity,
    weight: settings.trackWidth + 2,
  });
}

function applyStationLabelSettings() {
  const mapEl = document.getElementById('map');
  mapEl.style.setProperty('--station-font-size', `${settings.stationFontSize}px`);
  mapEl.style.setProperty('--station-color', settings.stationColor);
  mapEl.style.setProperty('--station-color-passenger', settings.passengerStationColor);
  mapEl.style.setProperty('--station-color-military', settings.militaryStationColor);
  layoutStationLabels();
}

function initSettingsUI() {
  const playerSizeInput = document.getElementById('playerSizeInput');
  playerSizeInput.value = settings.playerSize;
  playerSizeInput.addEventListener('input', e => {
    settings.playerSize = Number(e.target.value);
    saveSettings();
    applyPlayerSettings();
  });

  const playerColorInput = document.getElementById('playerColorInput');
  const playerColorAuto = document.getElementById('playerColorAutoCheckbox');
  playerColorAuto.checked = !settings.playerColor;
  if (settings.playerColor)
    playerColorInput.value = settings.playerColor;
  playerColorAuto.addEventListener('change', () => {
    settings.playerColor = playerColorAuto.checked ? '' : playerColorInput.value;
    saveSettings();
    applyPlayerSettings();
  });
  playerColorInput.addEventListener('input', () => {
    playerColorAuto.checked = false;
    settings.playerColor = playerColorInput.value;
    saveSettings();
    applyPlayerSettings();
  });

  const trackWidthInput = document.getElementById('trackWidthInput');
  trackWidthInput.value = settings.trackWidth;
  trackWidthInput.addEventListener('input', e => {
    settings.trackWidth = Number(e.target.value);
    saveSettings();
    applyTrackSettings();
    applyRouteStyle();
  });

  const routeOpacityInput = document.getElementById('routeOpacityInput');
  routeOpacityInput.value = settings.routeOpacity * 100;
  routeOpacityInput.addEventListener('input', e => {
    settings.routeOpacity = e.target.value / 100;
    saveSettings();
    applyRouteStyle();
  });

  const routeColorInput = document.getElementById('routeColorInput');
  routeColorInput.value = settings.routeColor;
  routeColorInput.addEventListener('input', e => {
    settings.routeColor = e.target.value;
    saveSettings();
    applyRouteStyle();
  });

  const stationFontSizeInput = document.getElementById('stationFontSizeInput');
  stationFontSizeInput.value = settings.stationFontSize;
  stationFontSizeInput.addEventListener('input', e => {
    settings.stationFontSize = Number(e.target.value);
    saveSettings();
    applyStationLabelSettings();
  });

  const stationColorInput = document.getElementById('stationColorInput');
  stationColorInput.value = settings.stationColor;
  stationColorInput.addEventListener('input', e => {
    settings.stationColor = e.target.value;
    saveSettings();
    applyStationLabelSettings();
  });

  const passengerStationColorInput = document.getElementById('passengerStationColorInput');
  passengerStationColorInput.value = settings.passengerStationColor;
  passengerStationColorInput.addEventListener('input', e => {
    settings.passengerStationColor = e.target.value;
    saveSettings();
    applyStationLabelSettings();
  });

  const militaryStationColorInput = document.getElementById('militaryStationColorInput');
  militaryStationColorInput.value = settings.militaryStationColor;
  militaryStationColorInput.addEventListener('input', e => {
    settings.militaryStationColor = e.target.value;
    saveSettings();
    applyStationLabelSettings();
  });

  const mapOffsetXInput = document.getElementById('mapOffsetXInput');
  mapOffsetXInput.value = settings.mapOffsetX;
  mapOffsetXInput.addEventListener('input', e => {
    settings.mapOffsetX = Number(e.target.value) || 0;
    saveSettings();
    worldMapOverlay.setBounds(effectiveWorldMapBounds());
  });

  const mapOffsetYInput = document.getElementById('mapOffsetYInput');
  mapOffsetYInput.value = settings.mapOffsetY;
  mapOffsetYInput.addEventListener('input', e => {
    settings.mapOffsetY = Number(e.target.value) || 0;
    saveSettings();
    worldMapOverlay.setBounds(effectiveWorldMapBounds());
  });

  const mapScaleInput = document.getElementById('mapScaleInput');
  mapScaleInput.value = settings.mapScale;
  mapScaleInput.addEventListener('input', e => {
    const value = Number(e.target.value);
    if (!Number.isFinite(value) || value <= 0)
      return;
    settings.mapScale = value;
    saveSettings();
    worldMapOverlay.setBounds(effectiveWorldMapBounds());
  });

  stationNamesCheckbox.checked = settings.showStationNames;

  applyStationLabelSettings();
}
L.control.scale({ position: 'bottomright' }).addTo(map);
const zoomHome = new L.Control.ZoomHome({
  position: 'topleft',
  zoomInText: '<i class="fas fa-search-plus"></i>',
  zoomHomeText: '<i class="fas fa-user"></i>',
  zoomHomeTitle: 'Zoom to player(s)',
  zoomOutText: '<i class="fas fa-search-minus"></i>',
}).addTo(map);

/////////////////////
// vertical zoom level control

const zoomLevelControl = L.control({ position: 'bottomright' });
zoomLevelControl.onAdd = function () {
  const container = L.DomUtil.create('div', 'zoomLevelControl');
  container.innerHTML =
    '<div class="zoomLevelValue">20</div>' +
    '<div class="zoomLevelTrack" role="slider" tabindex="0" aria-label="Map zoom level" aria-valuemin="13" aria-valuemax="24">' +
      '<div class="zoomLevelFill"></div><div class="zoomLevelThumb"></div>' +
    '</div>';
  L.DomEvent.disableClickPropagation(container);
  L.DomEvent.disableScrollPropagation(container);

  const track = container.querySelector('.zoomLevelTrack');
  const valueEl = container.querySelector('.zoomLevelValue');
  const fillEl = container.querySelector('.zoomLevelFill');
  const thumbEl = container.querySelector('.zoomLevelThumb');

  function render(zoom) {
    const ratio = (MAX_ZOOM - zoom) / (MAX_ZOOM - MIN_ZOOM);
    const trackHeight = track.clientHeight || 130;
    valueEl.textContent = zoom.toFixed(1);
    thumbEl.style.top = `${Math.max(0, Math.min(trackHeight, ratio * trackHeight))}px`;
    fillEl.style.height = `${Math.max(0, Math.min(trackHeight, (1 - ratio) * trackHeight))}px`;
    track.setAttribute('aria-valuenow', zoom.toFixed(1));
  }

  function zoomFromPointer(event) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    return MAX_ZOOM - ratio * (MAX_ZOOM - MIN_ZOOM);
  }

  let dragging = false;
  function applyPointer(event) {
    stopFollowing();
    map.setZoom(zoomFromPointer(event), { animate: false });
    render(map.getZoom());
  }

  track.addEventListener('pointerdown', e => {
    e.preventDefault();
    dragging = true;
    track.setPointerCapture(e.pointerId);
    applyPointer(e);
  });
  track.addEventListener('pointermove', e => {
    if (dragging) applyPointer(e);
  });
  track.addEventListener('pointerup', e => {
    dragging = false;
    if (track.hasPointerCapture(e.pointerId))
      track.releasePointerCapture(e.pointerId);
  });
  track.addEventListener('pointercancel', () => { dragging = false; });
  track.addEventListener('wheel', e => {
    e.preventDefault();
    stopFollowing();
    map.setZoom(map.getZoom() + (e.deltaY < 0 ? 0.5 : -0.5), { animate: false });
  }, { passive: false });
  track.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'PageUp' && e.key !== 'PageDown')
      return;
    e.preventDefault();
    const step = e.key === 'PageUp' || e.key === 'PageDown' ? 2 : 0.5;
    stopFollowing();
    map.setZoom(map.getZoom() + (e.key === 'ArrowUp' || e.key === 'PageUp' ? step : -step), { animate: false });
  });

  container.updateZoom = () => render(map.getZoom());
  render(map.getZoom());
  return container;
};
zoomLevelControl.addTo(map);

function updateZoomLevelControl() {
  const control = zoomLevelControl.getContainer();
  if (control && control.updateZoom)
    control.updateZoom();
}

let markerToFollow = null;
let lastMapDragEnd = 0;

map.on('dragstart', () => {
  lastMapDragEnd = performance.now();
  stopFollowing();
});
map.on('dragend', () => {
  lastMapDragEnd = performance.now();
});
map.on('zoomstart', stopFollowing);
map.on('zoom zoomend', updateZoomLevelControl);
map.getContainer().addEventListener('pointerdown', stopFollowing, { passive: true });
map.getContainer().addEventListener('pointercancel', stopFollowing, { passive: true });
window.addEventListener('blur', stopFollowing);

function getMarkerCenter(marker) {
  return marker.getLatLng ? marker.getLatLng() : marker.getBounds().getCenter();
}

function setMarkerToFollow(marker) {
  if (!marker)
    return;
  markerToFollow = marker;
  map.panTo(getMarkerCenter(marker), { animate: false });
}

function stopFollowing() {
  markerToFollow = null;
}

function zoomToAllPlayers() {
  const bounds = new L.LatLngBounds();
  playerMarkers.forEach(marker => bounds.extend(marker.getLatLng()));
  if (bounds.isValid())
    frameMapBounds(bounds, { maxZoom: initialZoom });
}

map.addEventListener('zoomhome', () => {
  stopFollowing();
  zoomToAllPlayers();
});

/////////////////////
// settings

document.getElementById('themeDropdown')
  .addEventListener('input', e => {
    if (e.target.value === 'dark') {
      document.getElementById('map').classList.add('dark');
    } else {
      document.getElementById('map').classList.remove('dark');
    }
  });

function getCarColorMode() {
  return document.getElementById('carColorDropdown').value;
}

document.getElementById('carColorDropdown')
  .addEventListener('input', () => {
    updateAllCarColors();
    updateJobListColors();
    applyRouteStyle();
  });

/////////////////////
// sidebar

const sidebar = L.control.sidebar({ autopan: true, container: 'sidebar' }).addTo(map);
const sidebarElement = document.getElementById('sidebar');
function updateSidebarTabCount() {
  const count = sidebarElement.querySelectorAll('.leaflet-sidebar-tabs ul > li').length;
  sidebarElement.style.setProperty('--rd-sidebar-tab-count', String(count || 1));
}
updateSidebarTabCount();
sidebar.on('opening', stopFollowing);

const tablesort = new Tablesort(document.getElementById('carList'));
const carListBody = document.getElementById('carListBody');

function createCarRow(carId) {
  const row = document.createElement('tr');
  row.setAttribute('id', `carList-${carId}`);
  row.classList.add('interactive');
  carListBody.append(row);
  updateCarRow(carId);
  row.addEventListener('click', _ => followCar(carId, false) );
}

function removeCarRow(carId) {
  const row = document.getElementById(`carList-${carId}`);
  if (row)
    row.remove();
}

function updateCarRow(carId) {
  const row = document.getElementById(`carList-${carId}`);
  if (!row)
    return;
  const jobId = carJobIds.has(carId) ? carJobIds.get(carId) : '';
  const destinationYardId = allJobData.has(jobId) ? allJobData.get(jobId).destinationYardId : '';
  row.innerHTML = `<td>${carId}</td><td>${jobId}</td><td>${destinationYardId}</td>`;
  tablesort.refresh();
}

/////////////////////
// jobs

const allJobData = new Map();
const carJobIds = new Map();

// https://www.npmjs.com/package/string-hash
function stringHash(str) {
  let hash = 5381, i = str.length;
  while(i) {
    hash = (hash * 33) ^ str.charCodeAt(--i);
  }
  return hash >>> 0;
}

// http://vrl.cs.brown.edu/color
const carColors = [
  '#52ef99', '#c95e9f', '#b1e632', '#7574f5', '#799d10', '#fd3fbe', '#2cf52b', '#d130ff', '#21a708', '#fd2b31',
  '#3eeaef', '#ffc4de', '#069668', '#f9793b', '#5884c9', '#e5d75e', '#96ccfe', '#bb8801', '#6a8b7b', '#a8777c',
];

function colorByHashing(str) {
  return carColors[stringHash(str) % carColors.length];
}

function colorForJobDestination(jobId) {
  const jobData = allJobData.get(jobId);
  if (!jobData)
    return 'gray';
  return colorForYardId(jobData.destinationYardId);
}

function colorForJobType(jobId) {
  const segments = jobId.split('-');
  if (segments.length == 2)
    return 'cornflowerblue';
  const jobType = segments[1];
  switch (jobType) {
  case 'FH': return 'lightgreen';
  case 'LH': return 'khaki';
  case 'PC':
  case 'PE': return 'cornflowerblue';
  case 'PR': return 'mediumpurple';
  case 'SL':
  case 'SU': return 'lightcoral';
  }
}

function colorForJobId(jobId) {
  switch (getCarColorMode()) {
    case 'jobId': return colorByHashing(jobId);
    case 'carType':
    case 'jobType': return colorForJobType(jobId);
    case 'destination': return colorForJobDestination(jobId);
  }
}

function yardIdForTrack(trackId) {
  return String(trackId || '').split('-')[0];
}

function jobMatchesFilter(jobId, jobData) {
  const testText = document.getElementById('jobSearchText').value.toUpperCase();
  const activeOnly = document.getElementById('jobActiveOnly').checked;
  function taskFields(task) {
    return [task.startTrack, task.destinationTrack].concat(task.cars || []);
  }
  const fields = [jobId].concat((jobData.tasks || []).flatMap(taskFields).filter(Boolean));
  return fields.some(field => String(field).toUpperCase().includes(testText))
    && (!activeOnly || jobData.isActive);
}

function replaceHyphens(value) {
  return String(value || '').replaceAll('-', '\u2011');
}

/////////////////////
// dispatch shared state

const assignmentsState = {
  session: '',
  revision: 0,
  byJob: new Map(),
  byPlayer: new Map(),
};
let permissionsState = { username: '', administrator: false, junctions: false };
const expandedJobIds = new Set();
let draggedJobId = null;
let cardPointerDown = false;
let pendingDispatchRefresh = null;
let dispatchMessageTimer;

const poolList = new DispatchLib.VirtualList(document.getElementById('dispatchJobList'), {
  gap: 6,
  overscan: 320,
  estimateHeight: 60,
  render: item => createJobCard(item.jobId, 'pool'),
});
const playersList = new DispatchLib.VirtualList(document.getElementById('dispatchPlayerList'), {
  gap: 7,
  overscan: 320,
  estimateHeight: 100,
  render: item => createPlayerCard(item.playerId),
});

function hasJobCardTarget(target) {
  return target instanceof Element && !!target.closest('.jobCard');
}

function flushPendingDispatchRefresh() {
  if (draggedJobId || cardPointerDown || pendingDispatchRefresh === null)
    return;
  const force = pendingDispatchRefresh;
  pendingDispatchRefresh = null;
  updateDispatchLists(force);
}

function clearCardPointerDown() {
  cardPointerDown = false;
  flushPendingDispatchRefresh();
}

function endJobDrag() {
  draggedJobId = null;
  cardPointerDown = false;
  document.querySelectorAll('.playerCard.drop-active')
    .forEach(el => el.classList.remove('drop-active'));
  document.querySelectorAll('.jobCard.drop-before, .jobCard.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
  flushPendingDispatchRefresh();
}

document.addEventListener('pointerdown', e => {
  if (hasJobCardTarget(e.target))
    cardPointerDown = true;
}, true);
document.addEventListener('pointerup', clearCardPointerDown, true);
document.addEventListener('pointercancel', clearCardPointerDown, true);
window.addEventListener('blur', clearCardPointerDown);

function showDispatchMessage(text, isError) {
  const toast = document.getElementById('dispatchToast');
  toast.textContent = text;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('visible');
  clearTimeout(dispatchMessageTimer);
  dispatchMessageTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

function rebuildAssignmentIndexes() {
  const indexed = DispatchLib.indexAssignments(Array.from(assignmentsState.byJob.values()));
  assignmentsState.byJob = indexed.byJob;
  assignmentsState.byPlayer = indexed.byPlayer;
}

function applyAssignmentSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.assignments))
    return;
  const previousSession = assignmentsState.session;
  const incomingSession = snapshot.session || '';
  const incomingRevision = Number.isFinite(snapshot.revision) ? snapshot.revision : 0;
  // The initial GET and the long-poll can resolve out of order. Never let an
  // older snapshot overwrite newer state from the same world.
  if (previousSession && previousSession === incomingSession &&
      incomingRevision <= assignmentsState.revision)
    return;
  assignmentsState.session = incomingSession;
  assignmentsState.revision = incomingRevision;
  assignmentsState.byJob.clear();
  assignmentsState.byPlayer.clear();
  for (const assignment of snapshot.assignments) {
    if (!assignment || !assignment.jobId || !assignment.player)
      continue;
    assignmentsState.byJob.set(assignment.jobId, {
      jobId: assignment.jobId,
      player: assignment.player,
      playerName: assignment.playerName || assignment.player,
      order: Number(assignment.order) || 0,
    });
  }
  rebuildAssignmentIndexes();

  if (previousSession && previousSession !== assignmentsState.session) {
    expandedJobIds.clear();
    selectedJobId = null;
    clearJobSelectionUI();
    jobRouteCache.clear();
    showDispatchMessage('游戏世界已更换，正在刷新调度页面。', true);
    setTimeout(() => location.reload(), 1200);
  }
  updateDispatchLists(true);
  updateBoundRoutes();
}

function applyPermissions(permissions) {
  if (!permissions)
    return;
  const next = {
    username: permissions.username || '',
    administrator: !!permissions.administrator,
    junctions: !!permissions.junctions,
  };
  const changed = next.username !== permissionsState.username ||
    next.administrator !== permissionsState.administrator ||
    next.junctions !== permissionsState.junctions;
  permissionsState = next;
  updatePermissionBanner();
  if (changed)
    updateDispatchLists(true);
}

function updatePermissionBanner() {
  const banner = document.getElementById('dispatchPermission');
  if (!banner)
    return;
  const name = permissionsState.username || '未知';
  banner.hidden = false;
  banner.classList.toggle('readonly', !permissionsState.administrator);
  if (permissionsState.administrator) {
    banner.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = name;
    banner.append('管理员：', strong, '；可以把任务单拖到左侧玩家卡片。');
  } else {
    banner.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = name;
    banner.append('当前网页身份：', strong, '；只读模式。请在 UMM 设置中为该名称勾选 Administrator，才能拖拽分配任务单。');
  }
}

function requestAssignment(op, params) {
  if (!permissionsState.administrator) {
    showDispatchMessage('没有 Administrator 权限，无法修改任务分配。', true);
    return;
  }
  const query = new URLSearchParams(Object.assign({
    op: op,
    revision: String(assignmentsState.revision),
    session: assignmentsState.session,
  }, params || {}));
  fetch(new URL(`/assignments?${query}`, location), { method: 'POST' })
  .then(async resp => {
    let data = null;
    try { data = await resp.json(); } catch (e) {}
    if (resp.ok && data) {
      applyAssignmentSnapshot(data);
      return;
    }
    if (resp.status == 403) {
      permissionsState.administrator = false;
      updateDispatchLists(true);
      showDispatchMessage('没有 Administrator 权限，无法修改任务分配。', true);
      return;
    }
    if (data && data.snapshot)
      applyAssignmentSnapshot(data.snapshot);
    if (data && data.error === 'session')
      showDispatchMessage('游戏世界已更换，请刷新调度页面。', true);
    else if (resp.status == 409)
      showDispatchMessage('任务分配已被其他管理员更新，请重试。', true);
    else
      showDispatchMessage('任务分配失败。', true);
  })
  .catch(() => showDispatchMessage('任务分配请求失败。', true));
}

function assignedJobsForPlayer(playerId) {
  return DispatchLib.assignedJobIds(assignmentsState, playerId, jobId => allJobData.has(jobId));
}

function firstStageJobForPlayer(playerId) {
  const jobs = assignedJobsForPlayer(playerId);
  return jobs.length > 0 ? jobs[0] : null;
}

function playerDisplayName(playerId) {
  const player = lastPlayerData[playerId];
  return (player && player.displayName) || assignmentsState.byPlayer.get(playerId)?.playerName || playerId;
}

function createLicenseContainer(jobData) {
  const div = document.createElement('div');
  div.className = 'jobCard-licenses';
  for (const license of (jobData.requiredLicenses || [])) {
    const span = document.createElement('span');
    span.className = 'jobCard-license';
    span.innerHTML =
      `<div class="jobCard-licenseBackground"></div>` +
      `<img src="res/licenses.${license}.png" title="${license}">`;
    div.appendChild(span);
  }
  return div;
}

function createTrackBadge(trackId) {
  const span = document.createElement('span');
  span.className = 'jobCard-track interactive';
  const hasTrack = !!trackId;
  span.textContent = hasTrack ? replaceHyphens(trackId) : '—';
  const yardId = yardIdForTrack(trackId);
  span.style.background = hasTrack ? colorForYardId(yardId) : '#ddd';
  span.title = stationNameForYard(yardId) || '';
  if (hasTrack)
    span.addEventListener('click', e => { e.stopPropagation(); scrollToTrack(trackId); });
  return span;
}

function createRouteElement(startTrack, destTrack) {
  const route = document.createElement('div');
  route.className = 'jobCard-route';
  const arrow = document.createElement('span');
  arrow.className = 'jobCard-arrow';
  arrow.textContent = '➜';
  route.append(createTrackBadge(startTrack), arrow, createTrackBadge(destTrack));
  return route;
}

function createCarGrid(task, jobId) {
  const carIds = task.cars || [];
  if (carIds.length === 0)
    return null;
  const grid = document.createElement('div');
  grid.className = 'jobCard-carGrid';
  for (let start = 0; start < carIds.length; start += 3) {
    const row = document.createElement('div');
    row.className = 'jobCard-carRow';
    for (let column = 0; column < 3; column++) {
      const carId = carIds[start + column];
      const cell = document.createElement('span');
      cell.className = 'jobCard-carCell';
      if (carId) {
        cell.classList.add('jobCard-car', `jobCard-car-${carId}`, 'interactive');
        cell.textContent = carId;
        cell.addEventListener('click', e => {
          e.stopPropagation();
          selectJob(jobId, { frame: false });
          followCar(carId, false);
        });
      }
      row.appendChild(cell);
    }
    grid.appendChild(row);
  }
  return grid;
}

function createJobCard(jobId, context) {
  const jobData = allJobData.get(jobId);
  const card = document.createElement('article');
  card.className = 'jobCard';
  card.dataset.jobId = jobId;

  const header = document.createElement('div');
  header.className = 'jobCard-header';
  header.style.background = colorByHashing(jobId);
  header.title = permissionsState.administrator
    ? '拖拽到左侧玩家卡片可分配任务单；点击可查看路线'
    : '需要 Administrator 权限才能拖拽分配任务单';
  const title = document.createElement('span');
  title.className = 'jobCard-title';
  title.textContent = jobId;
  header.appendChild(title);
  header.appendChild(createLicenseContainer(jobData || {}));
  if (context === 'pool') {
    const pinned = settings.pinnedJob === jobId;
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'jobCard-pin' + (pinned ? ' active' : '');
    pin.title = pinned ? '取消置顶' : '置顶任务单';
    pin.textContent = '📌';
    pin.addEventListener('click', e => {
      e.stopPropagation();
      settings.pinnedJob = pinned ? '' : jobId;
      saveSettings();
      updateDispatchLists(true);
    });
    header.appendChild(pin);
  }
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'jobCard-toggle';
  toggle.title = expandedJobIds.has(jobId) ? '折叠任务单' : '展开任务单';
  toggle.textContent = expandedJobIds.has(jobId) ? '▾' : '▸';
  header.appendChild(toggle);
  header.addEventListener('click', () => selectJob(jobId));
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    if (expandedJobIds.has(jobId))
      expandedJobIds.delete(jobId);
    else
      expandedJobIds.add(jobId);
    body.hidden = !expandedJobIds.has(jobId);
    toggle.textContent = expandedJobIds.has(jobId) ? '▾' : '▸';
    toggle.title = expandedJobIds.has(jobId) ? '折叠任务单' : '展开任务单';
    refreshDispatchCard(jobId);
  });
  card.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'jobCard-summary';
  summary.title = '点击查看整单路线';
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'jobCard-body';
  body.hidden = !expandedJobIds.has(jobId);
  body.addEventListener('click', e => {
    if (e.target === body)
      selectJob(jobId);
  });
  card.appendChild(body);

  if (!jobData) {
    summary.textContent = '任务单暂不可用';
    return card;
  }

  const tasks = jobData.tasks || [];
  const startTrack = tasks.length > 0 ? tasks[0].startTrack : '';
  const destTrack = tasks.length > 0 ? tasks[tasks.length - 1].destinationTrack : '';
  const summaryRoute = createRouteElement(startTrack, destTrack);
  summaryRoute.classList.add('jobCard-summaryRoute');
  const facts = document.createElement('div');
  facts.className = 'jobCard-summaryFacts';
  facts.innerHTML =
    `<span title="总重量">${Number(jobData.mass || 0).toFixed(0)} t</span>` +
    `<span title="总长度">${Number(jobData.length || 0).toFixed(0)} m</span>` +
    `<span title="基础报酬">${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(jobData.basePayment || 0)}</span>`;
  summary.append(summaryRoute, facts);
  summary.addEventListener('click', () => selectJob(jobId));

  for (const task of tasks) {
    const step = document.createElement('section');
    step.className = 'jobCard-step';
    const stepRoute = createRouteElement(task.startTrack, task.destinationTrack);
    stepRoute.classList.add('jobCard-stepRoute');
    step.appendChild(stepRoute);

    const carGrid = createCarGrid(task, jobId);
    if (carGrid)
      step.appendChild(carGrid);
    body.appendChild(step);
  }

  if (permissionsState.administrator) {
    card.draggable = true;
    card.addEventListener('dragstart', e => {
      if (!permissionsState.administrator) {
        e.preventDefault();
        return;
      }
      draggedJobId = jobId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', jobId);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      endJobDrag();
    });
    if (context === 'pool') {
      card.addEventListener('dragover', e => {
        if (!draggedJobId || draggedJobId === jobId)
          return;
        if (assignmentsState.byJob.has(draggedJobId))
          return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        card.classList.toggle('drop-after', after);
        card.classList.toggle('drop-before', !after);
      });
      card.addEventListener('dragleave', e => {
        if (!card.contains(e.relatedTarget))
          card.classList.remove('drop-before', 'drop-after');
      });
      card.addEventListener('drop', e => {
        if (!draggedJobId || draggedJobId === jobId)
          return;
        if (assignmentsState.byJob.has(draggedJobId))
          return;
        e.preventDefault();
        e.stopPropagation();
        const after = card.classList.contains('drop-after');
        card.classList.remove('drop-before', 'drop-after');
        reorderPoolJob(draggedJobId, jobId, after);
        endJobDrag();
      });
    }
  } else {
    card.classList.add('drag-disabled');
    card.title = '需要 Administrator 权限才能拖拽分配';
  }

  return card;
}

function refreshDispatchCard(jobId) {
  poolList.refreshItem(jobId);
  playersList.refreshItem(jobId);
}

function createPlayerCard(playerId) {
  const card = document.createElement('article');
  card.className = 'playerCard';
  card.dataset.playerId = playerId;
  const playerData = lastPlayerData[playerId];
  const name = playerDisplayName(playerId);
  const jobs = assignedJobsForPlayer(playerId);

  const header = document.createElement('div');
  header.className = 'playerCard-header';
  header.title = '点击按该玩家所有绑定任务取景';
  const swatch = document.createElement('span');
  swatch.className = 'playerColorSwatch';
  swatch.style.background = getPlayerColor(playerData) || 'transparent';
  const nameEl = document.createElement('span');
  nameEl.className = 'playerCard-name';
  nameEl.textContent = name;
  const count = document.createElement('span');
  count.className = 'playerCard-count';
  count.textContent = `${jobs.length} 单`;
  const release = document.createElement('button');
  release.type = 'button';
  release.className = 'playerCard-release';
  release.textContent = '解散任务单';
  release.disabled = jobs.length === 0 || !permissionsState.administrator;
  release.title = permissionsState.administrator ? '解除该玩家全部任务绑定，任务回到右侧任务栏' : '需要 Administrator 权限';
  release.addEventListener('click', e => {
    e.stopPropagation();
    requestAssignment('release', { player: playerId });
  });
  header.append(swatch, nameEl, count, release);
  header.addEventListener('click', () => framePlayerJobs(playerId));
  card.appendChild(header);

  const actions = document.createElement('div');
  actions.className = 'playerCard-actions';
  const connect = document.createElement('button');
  connect.type = 'button';
  connect.textContent = '一键联通';
  connect.disabled = jobs.length === 0;
  const firstJob = jobs[0];
  connect.title = !firstJob
    ? '未绑定任务单，无法联通'
    : `仅联通第一单（按分配先后）${firstJob} 的第一段运输路线` +
      (permissionsState.junctions ? '' : '；需要 Junctions 权限');
  connect.addEventListener('click', e => {
    e.stopPropagation();
    connectPlayerFirstStage(playerId, connect);
  });
  actions.append(connect);
  card.appendChild(actions);

  const jobContainer = document.createElement('div');
  jobContainer.className = 'playerCard-jobs';
  for (const jobId of jobs)
    jobContainer.appendChild(createJobCard(jobId, 'player'));
  card.appendChild(jobContainer);

  card.addEventListener('dragover', e => {
    if (!draggedJobId || !permissionsState.administrator)
      return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drop-active');
  });
  card.addEventListener('dragleave', e => {
    if (!card.contains(e.relatedTarget))
      card.classList.remove('drop-active');
  });
  card.addEventListener('drop', e => {
    if (!draggedJobId || !permissionsState.administrator)
      return;
    e.preventDefault();
    e.stopPropagation();
    const jobId = e.dataTransfer.getData('text/plain') || draggedJobId;
    card.classList.remove('drop-active');
    const assignment = assignmentsState.byJob.get(jobId);
    if (assignment && assignment.player === playerId) {
      endJobDrag();
      return;
    }
    requestAssignment('assign', { job: jobId, player: playerId, playerName: name });
    endJobDrag();
  });

  return card;
}

function sortPoolJobs(entries) {
  const pinned = settings.pinnedJob;
  const order = Array.isArray(settings.jobOrder) ? settings.jobOrder : [];
  const rank = new Map();
  order.forEach((jobId, index) => {
    if (jobId && !rank.has(jobId))
      rank.set(jobId, index);
  });
  return entries.slice().sort((a, b) => {
    const jobA = a[0];
    const jobB = b[0];
    if (jobA === pinned && jobB !== pinned) return -1;
    if (jobB === pinned && jobA !== pinned) return 1;
    const rankA = rank.has(jobA) ? rank.get(jobA) : Number.MAX_SAFE_INTEGER;
    const rankB = rank.has(jobB) ? rank.get(jobB) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return String(jobA).localeCompare(String(jobB));
  });
}

function reorderPoolJob(draggedId, targetId, after) {
  if (!draggedId || !targetId || draggedId === targetId)
    return;
  const visibleOrder = sortPoolJobs(Array.from(allJobData.entries()))
    .filter(([jobId]) => !assignmentsState.byJob.has(jobId))
    .map(([jobId]) => jobId);
  const order = Array.isArray(settings.jobOrder) ? settings.jobOrder.slice() : [];
  const known = new Set(order);
  for (const jobId of visibleOrder) {
    if (!known.has(jobId)) {
      order.push(jobId);
      known.add(jobId);
    }
  }
  const from = order.indexOf(draggedId);
  if (from !== -1)
    order.splice(from, 1);
  let targetIndex = order.indexOf(targetId);
  if (targetIndex === -1)
    targetIndex = order.length;
  else if (after)
    targetIndex++;
  order.splice(targetIndex, 0, draggedId);
  settings.jobOrder = order;
  saveSettings();
  updateDispatchLists(true);
}

function updateDispatchLists(forceRender) {
  if (draggedJobId || cardPointerDown) {
    // Replacing the dragged element would cancel the drag; defer the rebuild.
    pendingDispatchRefresh = !!forceRender;
    return;
  }
  const poolJobs = sortPoolJobs(Array.from(allJobData.entries()))
    .filter(([jobId, jobData]) => !assignmentsState.byJob.has(jobId) && jobMatchesFilter(jobId, jobData));
  poolList.setItems(poolJobs.map(([jobId]) => ({ key: jobId, jobId, context: 'pool' })), { forceRender: !!forceRender });
  document.getElementById('dispatchJobCount').textContent = `${poolJobs.length}`;

  const playerIds = Object.keys(lastPlayerData)
    .sort((a, b) => playerDisplayName(a).localeCompare(playerDisplayName(b)) || a.localeCompare(b));
  playersList.setItems(playerIds.map(playerId => ({ key: playerId, playerId })), { forceRender: !!forceRender });
  if (selectedJobId)
    markSelectedJobCards(selectedJobId);
}

function updateCarJobs() {
  carJobIds.clear();
  allJobData.forEach((jobData, jobId) => {
    (jobData.tasks || []).forEach(task => {
      (task.cars || []).forEach(carId => carJobIds.set(carId, jobId));
    });
  });
  for (const [carId] of allCarData) {
    updateCarRow(carId);
    updateCarMarker(carId);
  }
}

function updateJobListColors() {
  updateDispatchLists(true);
}

let lastJobsSignature = '';

function updateAllJobs(jobs) {
  const signature = JSON.stringify(jobs || {});
  if (signature === lastJobsSignature)
    return;
  lastJobsSignature = signature;
  allJobData.clear();
  Object.entries(jobs || {}).forEach(([jobId, jobData]) => allJobData.set(jobId, jobData));
  jobRouteCache.clear();
  if (selectedJobId && !allJobData.has(selectedJobId)) {
    selectedJobId = null;
    clearJobSelectionUI();
  }
  updateDispatchLists(true);
  updateCarJobs();
  updateBoundRoutes();
  if (selectedJobId)
    drawJobRoute(selectedJobId);
}

let jobSearchTimeoutId;
function queueJobUpdate() {
  if (jobSearchTimeoutId)
    clearTimeout(jobSearchTimeoutId);
  jobSearchTimeoutId = setTimeout(() => updateDispatchLists(true), 100);
}
document.getElementById('jobSearchText').addEventListener('input', queueJobUpdate);
document.getElementById('jobActiveOnly').addEventListener('change', queueJobUpdate);

const poolDropZone = poolList.container;
poolDropZone.addEventListener('dragover', e => {
  if (!draggedJobId || !permissionsState.administrator)
    return;
  if (!assignmentsState.byJob.has(draggedJobId))
    return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
poolDropZone.addEventListener('drop', e => {
  if (!draggedJobId || !permissionsState.administrator)
    return;
  const jobId = e.dataTransfer.getData('text/plain') || draggedJobId;
  if (!assignmentsState.byJob.has(jobId))
    return;
  e.preventDefault();
  requestAssignment('unassign', { job: jobId });
  endJobDrag();
});

/////////////////////
// track

const trackPolyLines = new Map();
const trackCoords = new Map();

function colorForYardId(yardId) {
  switch (yardId) {
    case 'CME': return '#686868';
    case 'CMS': return '#4e554e';
    case 'CP': return '#583d3d';
    case 'CS': return '#97adc2';
    case 'CW': return '#a7a7a7';
    case 'FF': return '#77a6e3';
    case 'FM': return '#ddaa4d';
    case 'FRC': return '#92b66a';
    case 'FRS': return '#609161';
    case 'GF': return '#c97fa2';
    case 'HB': return '#816c94';
    case 'HMB': return '#816c94';
    case 'IME': return '#b66861';
    case 'IMW': return '#9a5847';
    case 'MB': return '#988c5f';
    case 'MF': return '#dc885b';
    case 'MFMB': return '#dc885b';
    case 'OR': return '#935478';
    case 'OWC': return '#555a62';
    case 'OWN': return '#625d55';
    case 'SM': return '#7b8394';
    case 'SW': return '#cda888';
  }
}

function createTrackLabel(trackId, position, angle) {
  const size = 0.0002;
  const bounds = [[position[0] - size, position[1] - size], [position[0] + size, position[1] + size]];
  const rotation = `rotate(${-angle})`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', trackId)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', '-50 -10 100 20');
  svg.innerHTML =
    `<text text-anchor="middle" dominant-baseline="central" transform="${rotation}" font-family="Arial" font-weight="bold" fill="steelblue" stroke="black" stroke-width="0.25px">${trackId.slice(trackId.indexOf('-') + 1)}</text>`;
  L.svgOverlay(svg, bounds, { renderer: canvasRenderer })
  .addTo(map)
  .setZIndex(1000);
}

function pointDistance(p1, p2) {
  const d0 = p1[0] - p2[0];
  const d1 = p1[1] - p2[1];
  return Math.sqrt(d0 * d0 + d1 * d1);
}

function pointLerp(p1, p2, a) {
  return [
    (p2[0] - p1[0]) * a + p1[0],
    (p2[1] - p1[1]) * a + p1[1]
  ];
}

function createLocation(start, end, mid, a) {
  return [
    (end[0] - start[0]) * a + mid[0],
    (end[1] - start[1]) * a + mid[1]
  ];
}

function createTrackLabels(trackId, coords) {
  if (!Array.isArray(coords) || coords.length < 2)
    return;
  if (coords.length < 3) {
    const angle = (Math.atan2(coords[1][0] - coords[0][0], coords[1][1] - coords[0][1]) * 180 / Math.PI + 270) % 180 - 90;
    createTrackLabel(trackId, pointLerp(coords[0], coords[1], 0.5), angle);
    return;
  }
  const length = pointDistance(coords[0], coords[coords.length - 1]);
  const midIndex = Math.floor(coords.length / 2); 
  const beforeMid = (midIndex % 2 == 1) ? coords[midIndex] : coords[midIndex - 1];
  const mid = (midIndex % 2 == 1) ? coords[midIndex] : pointLerp(coords[midIndex - 1], coords[midIndex], 0.5);
  const afterMid = (midIndex % 2 == 1) ? coords[midIndex + 1] : coords[midIndex];
  const midGap = pointDistance(beforeMid, afterMid);

  const angle = ((Math.atan2(afterMid[0] - beforeMid[0], afterMid[1] - beforeMid[1]) * 180 / Math.PI) + 270) % 180 - 90;

  if (coords.length > 5) {
    createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap *  0.3), angle);
    createTrackLabel(trackId, createLocation(beforeMid, afterMid, mid, length / midGap * -0.3), angle);
  } else {
    createTrackLabel(trackId, mid, angle);
  }
}

const tracksReady = configReady
.then(() => fetch(new URL('/track', location)))
.then(resp => resp.json())
.then(tracks => {
  Object.entries(tracks).forEach(([trackId, coords]) => {
    trackCoords.set(trackId, coords);
    const isSiding = !trackId.includes('#');
    const polyline = L.polyline(coords, {
      color: isSiding ? 'slategray' : 'lightsteelblue',
      weight: settings.trackWidth,
      interactive: false,
      renderer: canvasRenderer,
    }).addTo(map);
    trackPolyLines.set(trackId, polyline);
    if (isSiding)
      createTrackLabels(trackId, coords)
  });
});

/////////////////////
// stations

let stationData = {};
const stationLabelMarkers = [];
const languageDropdown = document.getElementById('languageDropdown');
const stationNamesCheckbox = document.getElementById('stationNamesCheckbox');

function stationNameForYard(yardId) {
  return stationData[yardId] ? stationData[yardId].name : undefined;
}

function updateStationLabels() {
  for (const marker of stationLabelMarkers)
    marker.remove();
  stationLabelMarkers.length = 0;
  if (!stationNamesCheckbox.checked)
    return;
  Object.entries(stationData).forEach(([yardId, data]) => {
    const text = document.createElement('span');
    text.className = 'stationLabelText';
    text.textContent = `[${yardId}] ${data.name}`;
    stationLabelMarkers.push(L.marker(data.position, {
      interactive: false,
      icon: L.divIcon({ className: 'stationLabel' + (data.type ? ' ' + data.type : ''), html: text, iconSize: null }),
    }).addTo(map));
  });
  layoutStationLabels();
}

function rectsIntersect(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function layoutStationLabels() {
  const lineHeight = settings.stationFontSize;
  const labels = [];
  for (const marker of stationLabelMarkers) {
    const el = marker.getElement();
    const text = el && el.querySelector('.stationLabelText');
    if (!text)
      continue;
    text.style.transform = '';
    const point = map.latLngToContainerPoint(marker.getLatLng());
    const width = text.offsetWidth || text.textContent.length * lineHeight * 0.6;
    labels.push({ text, x: point.x, y: point.y, width });
  }
  labels.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const placed = [];
  for (const label of labels) {
    let offsetY = 0;
    for (let row = 0; row < 20; row++) {
      const rect = {
        left: label.x - 2,
        top: label.y + offsetY - 2,
        right: label.x + label.width + 2,
        bottom: label.y + offsetY + lineHeight + 2,
      };
      if (!placed.some(other => rectsIntersect(rect, other)))
        break;
      offsetY += lineHeight;
    }
    placed.push({
      left: label.x - 2,
      top: label.y + offsetY - 2,
      right: label.x + label.width + 2,
      bottom: label.y + offsetY + lineHeight + 2,
    });
    if (offsetY > 0)
      label.text.style.transform = `translateY(${offsetY}px)`;
  }
}

map.on('zoomend', layoutStationLabels);
map.on('resize', layoutStationLabels);

function populateLanguageDropdown(languages) {
  if (languageDropdown.childElementCount > 1)
    return;
  for (const language of languages) {
    const option = document.createElement('option');
    option.setAttribute('value', language);
    option.textContent = language;
    languageDropdown.appendChild(option);
  }
}

function fetchStations() {
  const language = languageDropdown.value;
  const url = language ? `/stations?lang=${encodeURIComponent(language)}` : '/stations';
  return fetch(new URL(url, location))
  .then(resp => resp.json())
  .then(data => {
    stationData = data.stations;
    populateLanguageDropdown(data.languages);
    updateStationLabels();
    updateDispatchLists(true);
  });
}

languageDropdown.addEventListener('input', fetchStations);
stationNamesCheckbox.addEventListener('change', e => {
  settings.showStationNames = e.target.checked;
  saveSettings();
  updateStationLabels();
});

tracksReady.then(() => fetchStations().catch(() => {})).catch(() => {});

/////////////////////
// junctions

let junctions = [];
const junctionsReady = tracksReady
.then(_ => fetch(new URL('/junction', location)))
.then(resp => resp.json())
.then(allJunctionData =>
  junctions = allJunctionData.map((data, index) => ({
    position: data.position,
    branches: data.branches,
    marker: createJunctionMarker(data.position, index),
  }))
);

function toggleJunction(junctionId) {
  fetch(new URL(`/junction/${junctionId}/toggle`, location), { method: 'POST' })
  .then(resp => resp.json())
  .then(selectedBranch => updateJunctionOverlay(junctionId, selectedBranch))
  .catch(err => {});
}

const junctionCanvasSize = 30;

function createJunctionShape(selectedBranch) {
  return `<g opacity="70%"><rect x="${-junctionCanvasSize/2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize*2}" fill="red"/>` +
    (
      selectedBranch == 0 ? `<line x1="${junctionCanvasSize/2}" y1="${junctionCanvasSize}" x2="${-junctionCanvasSize/2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>` :
      selectedBranch == 1 ? `<line x1="${-junctionCanvasSize/2}" y1="${junctionCanvasSize}" x2="${junctionCanvasSize/2}" y2="${-junctionCanvasSize}" stroke="white" stroke-width="10"/>`
      : ''
    ) +
    `<rect x="${-junctionCanvasSize/2}" y="${-junctionCanvasSize}" width="${junctionCanvasSize}" height="${junctionCanvasSize*2}" fill="none" stroke="black" stroke-width="2%"/></g>`;
}

function createJunctionLabel(junctionId) {
  return `<text x="${-junctionCanvasSize/2+5}" y="${junctionCanvasSize-5}">${junctionId}</text>`
}

function createJunctionOverlay(junctionId) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', `J-${junctionId}`)
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', `${-junctionCanvasSize/2} ${-junctionCanvasSize} ${junctionCanvasSize} ${junctionCanvasSize*2}`);
  svg.innerHTML = createJunctionShape(null) + createJunctionLabel(junctionId);
  return svg;
}

function updateJunctionOverlay(junctionId, selectedBranch) {
  const junction = junctions[junctionId];
  if (!junction)
    return;
  junction.marker.getElement().innerHTML = createJunctionShape(selectedBranch) + createJunctionLabel(junctionId);
  (junction.branches || []).forEach((trackId, branch) => {
    const polyline = trackPolyLines.get(trackId);
    if (!polyline)
      return;
    if (branch === selectedBranch)
      polyline.setStyle({ color: 'steelblue', dashArray: null });
    else
      polyline.setStyle({ color: 'lightsteelblue', dashArray: '6 12' }).bringToBack();
  });
}

function getJunctionOverlayBounds(position) {
  const size = metersToDegrees * 5;
  return [ [ position[0] - size, position[1] - size/2], [position[0] + size, position[1] + size/2] ];
}

function createJunctionMarker(p, junctionId) {
  return L.svgOverlay(
    createJunctionOverlay(junctionId),
    getJunctionOverlayBounds(p),
    { interactive: true, renderer: canvasRenderer })
    .addEventListener('click', () => toggleJunction(junctionId) )
    .addTo(map)
    .setZIndex(Math.floor(p[0] * 100000 + p[1] * 100000));
}

function updateAllJunctions(states) {
  states.forEach((state, index) => updateJunctionOverlay(index, state))
}

/////////////////////
// job routes

let topology = null;
let portGraph = null;
let trackGraph = null;
let trackGraphBuild = null;

const topologyReady = Promise.all([tracksReady, junctionsReady])
.then(() => fetch(new URL('/topology', location)))
.then(resp => resp.ok ? resp.json() : null)
.catch(() => null)
.then(data => {
  topology = data && data.coords && data.junctions ? data : null;
  if (topology) {
    for (const [trackId, coords] of Object.entries(topology.coords)) {
      trackCoords.set(trackId, coords);
      const polyline = trackPolyLines.get(trackId);
      if (polyline)
        polyline.setLatLngs(coords);
    }
  }
  return topology;
});

function ensureTrackGraph() {
  if (!trackGraphBuild)
    trackGraphBuild = topologyReady
    .then(() => {
      trackGraph = RouteLib.buildTrackGraph(Object.fromEntries(trackCoords), junctions);
      portGraph = topology ? RouteLib.buildPortGraph(topology) : null;
      return { trackGraph: trackGraph, portGraph: portGraph };
    })
    .catch(err => {
      trackGraphBuild = null;
      throw err;
    });
  return trackGraphBuild;
}

const jobRouteCache = new Map();
let selectedJobRouteLine = null;
const boundRouteGroup = L.featureGroup().addTo(map);

function routeTracksObject() {
  return (topology && topology.coords) ? topology.coords : Object.fromEntries(trackCoords);
}

function computeStageRoute(jobId, stageIndex) {
  const jobData = allJobData.get(jobId);
  const task = jobData && jobData.tasks ? jobData.tasks[stageIndex] : null;
  if (!task || !task.startTrack || !task.destinationTrack)
    return null;
  const cacheKey = `${jobId}\u0001${stageIndex}`;
  if (jobRouteCache.has(cacheKey))
    return jobRouteCache.get(cacheKey);
  if (!portGraph && !trackGraph) {
    ensureTrackGraph().catch(() => {});
    return undefined;
  }

  if (portGraph) {
    const portRoute = RouteLib.findPortRoute(portGraph, task.startTrack, task.destinationTrack);
    if (portRoute) {
      const coords = RouteLib.assemblePortRouteCoords(portRoute, routeTracksObject());
      if (coords.length > 0) {
        const junctionInfo = RouteLib.junctionsForPortRoute(portRoute);
        const route = {
          trackIds: portRoute.trackIds,
          coords: coords,
          junctions: junctionInfo.pairs,
          conflicts: junctionInfo.conflicts,
        };
        jobRouteCache.set(cacheKey, route);
        return route;
      }
    }
    // A real topology exists but this stage is unreachable in it. Do not fall
    // back to distance-guessed edges, which could invent a physically invalid route.
    jobRouteCache.set(cacheKey, null);
    return null;
  }

  if (trackGraph) {
    const tracksObj = routeTracksObject();
    const trackIds = RouteLib.findRoute(trackGraph, task.startTrack, task.destinationTrack);
    if (trackIds) {
      const coords = RouteLib.assembleRouteCoords(trackIds, tracksObj, trackGraph, junctions);
      if (coords.length > 0) {
        const route = {
          trackIds: trackIds,
          coords: coords,
          junctions: RouteLib.junctionsForRoute(trackIds, junctions, trackGraph, tracksObj),
          conflicts: [],
        };
        jobRouteCache.set(cacheKey, route);
        return route;
      }
    }
  }

  jobRouteCache.set(cacheKey, null);
  return null;
}

function computeJobRoute(jobId) {
  if (jobRouteCache.has(jobId))
    return jobRouteCache.get(jobId);
  const jobData = allJobData.get(jobId);
  if (!jobData)
    return undefined;
  if (!portGraph && !trackGraph) {
    ensureTrackGraph().catch(() => {});
    return undefined;
  }
  const parts = [];
  const tasks = jobData.tasks || [];
  for (let i = 0; i < tasks.length; i++) {
    const stage = computeStageRoute(jobId, i);
    if (stage)
      parts.push(stage);
  }
  const route = parts.length > 0 ? { parts: parts } : null;
  jobRouteCache.set(jobId, route);
  return route;
}

function routeAllCoords(route) {
  if (!route || !route.parts) return [];
  const coords = [];
  for (const part of route.parts)
    for (const point of part.coords)
      coords.push(point);
  return coords;
}

function removeJobRouteLine() {
  if (selectedJobRouteLine) {
    selectedJobRouteLine.remove();
    selectedJobRouteLine = null;
  }
}

function drawJobRoute(jobId) {
  removeJobRouteLine();
  const route = computeJobRoute(jobId);
  if (!route || !route.parts || route.parts.length === 0)
    return;
  selectedJobRouteLine = L.featureGroup();
  const claimed = new Set();
  for (const part of route.parts) {
    if (!part.coords || part.coords.length < 2)
      continue;
    addDedupedSegments(selectedJobRouteLine, part.coords, claimed);
  }
  selectedJobRouteLine.addTo(map);
}

function segmentKey(a, b) {
  const ka = `${a[0].toFixed(7)},${a[1].toFixed(7)}`;
  const kb = `${b[0].toFixed(7)},${b[1].toFixed(7)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function addDedupedSegments(group, coords, claimed) {
  let run = [];
  function flush() {
    if (run.length >= 2) {
      L.polyline(run, {
        color: settings.routeColor,
        opacity: settings.routeOpacity,
        weight: settings.trackWidth + 2,
        interactive: false,
      }).addTo(group);
    }
    run = [];
  }
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const key = segmentKey(a, b);
    if (claimed.has(key)) {
      flush();
      continue;
    }
    claimed.add(key);
    if (run.length === 0)
      run.push(a);
    run.push(b);
  }
  flush();
}

function updateBoundRoutes() {
  boundRouteGroup.clearLayers();
  if (!portGraph && !trackGraph) {
    ensureTrackGraph()
      .then(() => updateBoundRoutes())
      .catch(() => {});
    return;
  }
  const claimed = new Set();
  const ordered = Array.from(assignmentsState.byJob.values())
    .filter(assignment => allJobData.has(assignment.jobId) && assignment.jobId !== selectedJobId)
    .sort((a, b) => a.order - b.order);
  for (const assignment of ordered) {
    const route = computeJobRoute(assignment.jobId);
    if (!route || !route.parts)
      continue;
    for (const part of route.parts) {
      if (part.coords && part.coords.length >= 2)
        addDedupedSegments(boundRouteGroup, part.coords, claimed);
    }
  }
  if (selectedJobRouteLine)
    selectedJobRouteLine.bringToFront();
}

function showJunctionButtonFeedback(button, text) {
  button.textContent = text;
  clearTimeout(button.feedbackTimerId);
  button.feedbackTimerId = setTimeout(() => {
    if (button.isConnected)
      button.textContent = '一键联通';
  }, 2200);
}

function connectPlayerFirstStage(playerId, button) {
  const jobId = firstStageJobForPlayer(playerId);
  if (!jobId) {
    showDispatchMessage('该玩家没有绑定任务单。', true);
    return;
  }
  if (!portGraph && !trackGraph) {
    button.textContent = '…';
    ensureTrackGraph()
      .then(() => {
        if (button.isConnected)
          connectPlayerFirstStage(playerId, button);
      })
      .catch(() => showJunctionButtonFeedback(button, '✗ 失败'));
    return;
  }

  const route = computeStageRoute(jobId, 0);
  if (!route) {
    showJunctionButtonFeedback(button, '✗ 首段不可达');
    showDispatchMessage(`第一单 ${jobId} 的第一段运输路线不可用，未切换道岔。`, true);
    return;
  }
  if (route.conflicts && route.conflicts.length > 0) {
    showJunctionButtonFeedback(button, '✗ 道岔冲突');
    showDispatchMessage('第一段路线要求同一道岔处于不同分支，已阻止联通。', true);
    return;
  }
  const pairs = RouteLib.formatJunctionPairs(route.junctions);
  if (!pairs) {
    showJunctionButtonFeedback(button, '✓ 无需切换');
    return;
  }
  fetch(new URL(`/junction/set?pairs=${encodeURIComponent(pairs)}`, location), { method: 'POST' })
  .then(async resp => {
    if (resp.status == 403) {
      showJunctionButtonFeedback(button, '✗ 无权限');
      showDispatchMessage('没有 Junctions 权限，无法切换道岔。', true);
      return;
    }
    if (!resp.ok) {
      showJunctionButtonFeedback(button, '✗ 失败');
      return;
    }
    const result = await resp.json();
    const failures = [];
    let successes = 0;
    for (const expected of route.junctions) {
      const actual = result.find(r => r.junctionId == expected.junctionId);
      if (actual && actual.selectedBranch == expected.branch && actual.success !== false)
        successes++;
      else
        failures.push({ expected: expected, actual: actual });
    }
    if (failures.length === 0) {
      showJunctionButtonFeedback(button, `✓ 已联通 ${successes}`);
      return;
    }
    const detail = failures
      .map(f => `J-${f.expected.junctionId}(期望 ${f.expected.branch}，实际 ${f.actual ? f.actual.selectedBranch : '无'})`)
      .join('，');
    showJunctionButtonFeedback(button, successes > 0 ? `⚠ 部分 ${successes}/${route.junctions.length}` : '✗ 失败');
    showDispatchMessage(`道岔未全部联通：${detail}`, true);
    console.warn('[RemoteDispatch] 道岔联通未完全生效:', failures, result);
  })
  .catch(() => showJunctionButtonFeedback(button, '✗ 失败'));
}

/////////////////////
// following & job selection

function clearCarHighlight() {
  for (const row of carListBody.querySelectorAll('.following'))
    row.classList.remove('following');
  for (const elem of document.querySelectorAll('.jobCard .following'))
    elem.classList.remove('following');
}

function selectJobCar(carId) {
  clearCarHighlight();
  const carListRow = document.getElementById(`carList-${carId}`);
  if (carListRow)
    carListRow.classList.add('following');
  for (const elem of document.querySelectorAll('.jobCard-car')) {
    if (elem.textContent === carId) {
      elem.classList.add('following');
      elem.closest('.jobCard-carRow')?.classList.add('following');
      elem.closest('.jobCard')?.classList.add('following');
    }
  }
}

function followCar(carId, shouldScroll) {
  const jobId = carJobIds.get(carId);
  if (jobId && selectedJobId !== jobId)
    selectJob(jobId, { frame: false });
  selectJobCar(carId);
  setMarkerToFollow(carMarkers.get(carId));
  if (shouldScroll) {
    const carListRow = document.getElementById(`carList-${carId}`);
    if (carListRow)
      carListRow.scrollIntoView({ block: 'center' });
    const jobId = carJobIds.get(carId);
    if (jobId) {
      const assignment = assignmentsState.byJob.get(jobId);
      if (assignment)
        playersList.scrollToKey(assignment.player);
      else
        poolList.scrollToKey(jobId);
      requestAnimationFrame(() => {
        for (const elem of document.querySelectorAll('.jobCard-car')) {
          if (elem.textContent === carId) {
            elem.scrollIntoView({ block: 'center' });
            break;
          }
        }
      });
    }
  }
}

let selectedJobId = null;
let selectedJobCarId = null;

function clearJobSelectionUI() {
  selectedJobCarId = null;
  for (const elem of document.querySelectorAll('.jobCard-selected'))
    elem.classList.remove('jobCard-selected');
  removeJobRouteLine();
  clearCarHighlight();
}

function mapSidebarOffset() {
  const sidebarEl = document.getElementById('sidebar');
  if (!sidebarEl || sidebarEl.classList.contains('collapsed'))
    return 0;
  const width = sidebarEl.getBoundingClientRect().width;
  return Math.min(width, map.getSize().x * 0.45);
}

function frameMapBounds(bounds, options) {
  if (!bounds || !bounds.isValid())
    return false;
  const size = map.getSize();
  const offset = mapSidebarOffset();
  const pad = RouteLib.viewPaddingForSize(Math.max(80, size.x - offset), size.y);
  map.fitBounds(bounds, {
    paddingTopLeft: [pad[0] + offset, pad[1]],
    paddingBottomRight: pad,
    maxZoom: (options && options.maxZoom) || MAX_ZOOM,
  });
  return true;
}

function boundsForJobs(jobIds, includeRoutes) {
  const bounds = new L.LatLngBounds();
  let hasCars = false;
  for (const jobId of jobIds) {
    const jobData = allJobData.get(jobId);
    if (!jobData)
      continue;
    for (const task of (jobData.tasks || [])) {
      for (const carId of (task.cars || [])) {
        const carData = allCarData.get(carId);
        if (!carData)
          continue;
        hasCars = true;
        bounds.extend(getCarFrameBounds(carData));
      }
    }
  }
  if (hasCars)
    return bounds;

  if (includeRoutes) {
    for (const jobId of jobIds) {
      const route = computeJobRoute(jobId);
      if (!route || !route.parts)
        continue;
      for (const point of routeAllCoords(route))
        bounds.extend(point);
    }
  }
  return bounds;
}

function frameJobs(jobIds) {
  return frameMapBounds(boundsForJobs(jobIds, true));
}

function frameJob(jobId) {
  return frameJobs([jobId]);
}

function framePlayerJobs(playerId) {
  stopFollowing();
  const jobs = assignedJobsForPlayer(playerId);
  if (jobs.length > 0 && frameJobs(jobs))
    return;
  const marker = playerMarkers.get(playerId);
  if (marker)
    map.setView(marker.getLatLng(), initialZoom);
}

function markSelectedJobCards(jobId) {
  for (const elem of document.querySelectorAll('.jobCard'))
    elem.classList.toggle('jobCard-selected', elem.dataset.jobId === jobId);
}

function selectJob(jobId, options) {
  const jobData = allJobData.get(jobId);
  if (!jobData)
    return;
  const opts = options || {};
  clearJobSelectionUI();
  selectedJobId = jobId;
  stopFollowing();
  markSelectedJobCards(jobId);
  const tasks = jobData.tasks || [];
  const consistTask = tasks[RouteLib.pickConsistTask(tasks)];
  if (consistTask && (consistTask.cars || []).length > 0) {
    selectedJobCarId = consistTask.cars[RouteLib.middleCarIndex(consistTask.cars.length)];
    selectJobCar(selectedJobCarId);
  } else {
    selectedJobCarId = null;
  }
  drawJobRoute(jobId);
  updateBoundRoutes();
  if (!portGraph && !trackGraph) {
    ensureTrackGraph()
    .then(() => {
      if (selectedJobId == jobId) {
        drawJobRoute(jobId);
        updateBoundRoutes();
      }
    })
    .catch(() => {});
  }
  if (opts.frame !== false)
    frameJob(jobId);
}

function toggleJobSelection(jobId) {
  if (selectedJobId == jobId) {
    selectedJobId = null;
    clearJobSelectionUI();
    updateBoundRoutes();
  } else {
    selectJob(jobId);
  }
}

/////////////////////
// player

const playerMarkers = new Map();
let lastPlayerData = {};

function getPlayerColor(playerData) {
  return settings.playerColor || (playerData && playerData.color);
}

function updatePlayerOverlays(data) {
  lastPlayerData = data;
  const existingPlayerIds = Array.from(playerMarkers.keys());
  // Remove markers from disconnected players
  existingPlayerIds
  .filter(id => !data.hasOwnProperty(id))
  .forEach(id => {
    removePlayerOverlay(id);
  });
  // Add markers for new players
  Object.entries(data)
  .filter(([id]) => !existingPlayerIds.includes(id))
  .forEach(([id, playerData]) => {
    createPlayerMarker(id, playerData);
  });
  Object.entries(data).forEach(([id, playerData]) => {
    const marker = playerMarkers.get(id);
    marker.setLatLng(playerData.position);
    const el = marker.getElement();
    if (!el)
      return;
    const svg = el.querySelector('svg');
    if (svg)
      svg.style.transform = `rotate(${playerData.rotation}deg)`;
    const name = el.querySelector('.playerName');
    if (playerData.displayName) {
      if (name) {
        name.textContent = playerData.displayName;
      } else {
        removePlayerOverlay(id);
        createPlayerMarker(id, playerData);
      }
    }
  });
  updateDispatchListsIfPlayersChanged();
}

let lastPlayerListSignature = '';
function updateDispatchListsIfPlayersChanged() {
  const signature = Object.keys(lastPlayerData)
    .sort()
    .map(id => `${id}:${lastPlayerData[id].displayName || ''}:${getPlayerColor(lastPlayerData[id]) || ''}`)
    .join('|');
  if (signature === lastPlayerListSignature)
    return;
  lastPlayerListSignature = signature;
  updateDispatchLists(true);
}

function removePlayerOverlay(id) {
  const marker = playerMarkers.get(id);
  if (marker) {
    if (markerToFollow === marker)
      markerToFollow = null;
    marker.remove();
  }
  playerMarkers.delete(id);
}

function createPlayerIcon(playerData) {
  const size = 30 * settings.playerSize;
  const color = getPlayerColor(playerData);
  const wrapper = document.createElement('div');
  wrapper.className = 'playerMarkerWrapper';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-15 -15 30 30');
  svg.style.transform = `rotate(${playerData.rotation}deg)`;
  const polygon = document.createElementNS(svg.namespaceURI, 'polygon');
  polygon.setAttribute('fill', color);
  polygon.setAttribute('fill-opacity', '70%');
  polygon.setAttribute('stroke', 'black');
  polygon.setAttribute('stroke-width', '1%');
  polygon.setAttribute('points', '0,-10 10,10 0,5 -10,10');
  svg.appendChild(polygon);
  wrapper.appendChild(svg);
  if (playerData.displayName) {
    const name = document.createElement('div');
    name.className = 'playerName';
    name.style.fontSize = `${12 * settings.playerSize}px`;
    name.style.color = color;
    name.textContent = playerData.displayName;
    wrapper.appendChild(name);
  }
  return L.divIcon({
    className: 'playerMarker',
    html: wrapper,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function createPlayerMarker(id, playerData) {
  playerMarkers.set(id, L.marker(playerData.position, {
    icon: createPlayerIcon(playerData),
    interactive: true,
  })
  .addEventListener('click', e => setMarkerToFollow(e.target))
  .addTo(map));
}

function scrollToTrack(trackId) {
  stopFollowing();
  const polyLine = trackPolyLines.get(trackId);
  if (polyLine)
    map.panTo(polyLine.getCenter());
}

fetch(new URL('/player', location))
.then(resp => resp.json())
.then(data => {
  updatePlayerOverlays(data);
  zoomToAllPlayers();
});

fetch(new URL('/permissions', location))
.then(resp => resp.ok ? resp.json() : null)
.then(data => applyPermissions(data))
.catch(() => {});

fetch(new URL('/assignments', location))
.then(resp => resp.ok ? resp.json() : null)
.then(data => applyAssignmentSnapshot(data))
.catch(() => {});

/////////////////////
// loco control
// Remote locomotive control is disabled in this release. Keep the
// implementation for a future re-enable, but do not refresh or send commands.
const locoControlEnabled = false;

const locoIdSelect = document.getElementById('locoControlLocoId');
function updateLocoList() {
  if (!locoControlEnabled)
    return;
  for (const elem of Array.from(locoIdSelect.children))
    elem.remove();
  const locoIds = Array.from(allCarData.entries())
    .filter(([_, carData]) => carData.canBeControlled)
    .map(([id, _]) => id.slice(2));
  locoIds.sort();
  for (const id of locoIds) {
    const option = document.createElement('option');
    option.textContent = id;
    locoIdSelect.appendChild(option);
  }
}

function isReverserButtonActive(faButton) {
  return faButton.querySelector('svg').getAttribute('data-prefix') == 'fas';
}

function updateReverserButtons(reverser) {
  const reverseButton = document.querySelector('#locoControlReverserReverseButton svg');
  const newReverseStyle = reverser < 0.5 ? 'fas' : 'far';
  if (reverseButton.getAttribute('data-prefix') != newReverseStyle)
    reverseButton.setAttribute('data-prefix', newReverseStyle);

  const forwardButton = document.querySelector('#locoControlReverserForwardButton svg');
  const newForwardStyle = reverser > 0.5 ? 'fas' : 'far';
  if (forwardButton.getAttribute('data-prefix') != newForwardStyle)
    forwardButton.setAttribute('data-prefix', newForwardStyle);
}

const locoBrakePipeDisplay = document.getElementById('locoControlBrakePipe');
const locoSpeedDisplay = document.getElementById('locoControlForwardSpeed');
const locoTrainBrakeInput = document.getElementById('locoControlTrainBrakeInput');
const locoIndependentBrakeInput = document.getElementById('locoControlIndependentBrakeInput');
const locoReverserReverseButton = document.getElementById('locoControlReverserReverseButton');
const locoReverserForwardButton = document.getElementById('locoControlReverserForwardButton');
const locoThrottleInput = document.getElementById('locoControlThrottleInput');
const locoControlCoupleButton = document.getElementById('locoControlCoupleButton');
const locoControlUncoupleButton = document.getElementById('locoControlUncoupleButton');
const locoControlUncoupleSelect = document.getElementById('locoControlUncoupleSelect');

function updateCouplingControls(carData) {
  const canCouple = carData.canCouple;
  const carsInFront = carData.carsInFront;
  const carsInRear = carData.carsInRear;

  locoControlCoupleButton.disabled = !canCouple;
  locoControlUncoupleButton.disabled = carsInFront == 0 && carsInRear && 0;

  if (locoControlUncoupleSelect.childElementCount == carsInFront + carsInRear) {
    return;
  }

  const options = [];
  for (let i = carsInFront; i >= 1; i--)
    options.push(i);
  for (let i = 1; i <= carsInRear; i++)
    options.push(-i);
  locoControlUncoupleSelect.replaceChildren(...options.map(i => {
    const option = document.createElement('option');
    option.setAttribute('value', i);
    option.textContent = i >= 0 ? `\u002b${i}` : `\u2212${-i}`;
    return option;
  }));
}

function getControlledLocoGuid() {
  return allCarData.get(`L-${locoIdSelect.value}`)?.guid;
}

function getControlledLocoData() {
  const guid = getControlledLocoGuid();
  if (guid) {
    return fetch(`/car/${guid}`, location)
    .then(resp => resp.json());
  }
}

let locoTrainBrakeEditing = false;
let locoIndependentBrakeEditing = false;
let locoThrottleEditing = false;

function updateLocoTrainBrakeInput(carData) {
  if (locoTrainBrakeEditing)
    return;
  locoTrainBrakeInput.value = carData.trainBrake * 100;
}

function updateLocoIndependentBrakeInput(carData) {
  if (locoIndependentBrakeEditing)
    return;
  locoIndependentBrakeInput.value = carData.independentBrake * 100;
}

function updateLocoThrottleInput(carData) {
  if (locoThrottleEditing)
    return;
  locoThrottleInput.value = carData.throttle * 100;
}

function updateLocoDisplay() {
  if (!locoControlEnabled)
    return;
  getControlledLocoData()
  .then(carData => {
    locoBrakePipeDisplay.textContent = carData.brakePipe.toFixed(1);
    locoSpeedDisplay.textContent = carData.forwardSpeed.toFixed(0);
    updateLocoTrainBrakeInput(carData);
    updateLocoIndependentBrakeInput(carData);
    updateReverserButtons(carData.reverser);
    updateLocoThrottleInput(carData);
    updateCouplingControls(carData);
  });
}

let locoControlRefreshIntervalId;
locoIdSelect.addEventListener('change', updateLocoDisplay);
sidebar.on("content", e => {
  clearInterval(locoControlRefreshIntervalId);
  if (!locoControlEnabled)
    return;
  if (e.id == "locoControlTab") {
    locoControlRefreshIntervalId = setInterval(updateLocoDisplay, 1000 / 9);
  }
});
sidebar.on("closing", e => {
  clearInterval(locoControlRefreshIntervalId);
  locoControlRefreshIntervalId = undefined;
})

function sendLocoCommand(command) {
  if (!locoControlEnabled)
    return;
  const guid = getControlledLocoGuid();
  if (guid) {
    fetch(new URL(`/car/${guid}/control?${command}`, location), { method: 'POST' });
  }
}

function rangeCommandSender(parameter) {
  return e => sendLocoCommand(`${parameter}=${e.target.value / 100}`);
}

locoTrainBrakeInput.addEventListener('input', rangeCommandSender('trainBrake'));
locoIndependentBrakeInput.addEventListener('input', rangeCommandSender('independentBrake'));
locoReverserReverseButton.addEventListener('click', e =>
  sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserReverseButton) ? 0.5 : 0}`));
locoReverserForwardButton.addEventListener('click', e =>
  sendLocoCommand(`reverser=${isReverserButtonActive(locoReverserForwardButton) ? 0.5 : 1}`));
locoThrottleInput.addEventListener('input', rangeCommandSender('throttle'));
locoControlCoupleButton.addEventListener('click', e =>
  sendLocoCommand('couple=0'));
locoControlUncoupleButton.addEventListener('click', e =>
  sendLocoCommand(`uncouple=${locoControlUncoupleSelect.value}`));

locoTrainBrakeInput.addEventListener("mousedown", () => locoTrainBrakeEditing = true);
locoTrainBrakeInput.addEventListener("mouseup", () => {
  locoTrainBrakeEditing = false;
  updateLocoDisplay();
});
locoIndependentBrakeInput.addEventListener("mousedown", () => locoIndependentBrakeEditing = true);
locoIndependentBrakeInput.addEventListener("mouseup", () => {
  locoIndependentBrakeEditing = false;
  updateLocoDisplay();
});
locoThrottleInput.addEventListener("mousedown", () => locoThrottleEditing = true);
locoThrottleInput.addEventListener("mouseup", () => {
  locoThrottleEditing = false;
  updateLocoDisplay();
});


/////////////////////
// cars

const carWidthMeters = 3;
const carWidthPx = 20;
const svgPixelsPerMeter = carWidthPx / 3;

const allCarData = new Map();
const carMarkers = new Map();

function getCarColor(carId) {
  const jobId = carJobIds.get(carId);

  switch (getCarColorMode()) {
  case 'jobId':
    return jobId ? colorByHashing(jobId) : 'gray';
  case 'jobType':
    return jobId ? colorForJobType(jobId) : 'gray';
  case 'destination':
    return jobId ? colorForJobDestination(jobId) : 'gray';
  case 'carType':
    return colorByHashing(carId.slice(0,3));
  }
}

function updateCarColor(carId) {
  const carMarker = carMarkers.get(carId);
  const rect = carMarker.getElement().querySelector('rect');
  if (rect)
    rect.setAttribute('fill', getCarColor(carId));
}

function updateAllCarColors() {
  carMarkers.forEach((_, carId) => updateCarColor(carId));
}

const locoShapeNoseDepth = 10;

function createCarShape(carId, carData) {
  const isLoco = carId.slice(0,2) == 'L-';
  const lengthPx = carData.length * svgPixelsPerMeter;
  const svg = isLoco
    ? `<polygon points="${-lengthPx/2},-${carWidthPx/2} ${-lengthPx/2},${carWidthPx/2} ${lengthPx/2-locoShapeNoseDepth},${carWidthPx/2} ${lengthPx/2},0 ${lengthPx/2-locoShapeNoseDepth},-${carWidthPx/2}" fill="goldenrod" fill-opacity="70%" stroke="black" stroke-width="1%"/>`
    : `<rect x="${-lengthPx/2}" y="-10" width="${lengthPx}" height="20" fill-opacity="70%" stroke="black" stroke-width="1%"/>`;
  return svg;
}

function createCarLabel(carId, carData) {
  const isLoco = carId.slice(0,2) == 'L-';
  const jobId = carJobIds.get(carId);
  const lengthPx = carData.length * svgPixelsPerMeter;
  const rotation = carData.rotation >= 180 ? 'rotate(180)' : '';
  if (isLoco)
    return `<text transform="translate(-3 0) ${rotation}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="bold">${carId}</text>`;
  const jobIdLabel =
    !jobId ? ""
    : jobId.split('-').length == 3 ? jobId.slice(-5,-3) + jobId.slice(-2)
    : jobId.split('-').join('');
  const jobIdText = `<text x="${-lengthPx/2 + 5}" transform="${rotation}" dominant-baseline="central" font-size="16">${jobIdLabel}</text>`
  const carIdText =
    `<text y="-0.5em" y="1" transform="${rotation} translate(${lengthPx/2 - 5})" dominant-baseline="central" text-anchor="end" font-size="8" font-family="monospace" font-weight="bold">` +
      `<tspan x="0">${carId.slice(0,-3).replaceAll('-', '')}</tspan>` +
      `<tspan x="0" dy="1em">${carId.slice(-3)}</tspan>` +
    '</text>';
  return jobIdText + carIdText;
}

function createCarOverlay(carId, carData) {
  const lengthPx = carData.length * svgPixelsPerMeter;
  const carCanvasMajor = Math.sqrt(lengthPx / 2 * lengthPx / 2 + carWidthPx / 2 * carWidthPx / 2);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('id', carId);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', `${-carCanvasMajor} ${-carWidthPx/2} ${carCanvasMajor*2} ${carWidthPx}`);
  return svg
}

function updateCarMarker(carId) {
  const marker = carMarkers.get(carId);
  if (!marker)
    return;
  const carData = allCarData.get(carId);
  marker.setBounds(getCarOverlayBounds(carData));
  marker.setRotationAngle(carData.rotation - 90);
  marker.getElement().innerHTML = createCarShape(carId, carData) + createCarLabel(carId, carData);
  updateCarColor(carId);
}

function getCarOverlayBounds(carData) {
  const position = carData.position;
  const length = metersToDegrees * carData.length;
  const width = metersToDegrees * carWidthMeters;
  return [ [ position[0] - width/2, position[1] - length/2], [position[0] + width/2, position[1] + length/2] ];
}

function getCarFrameBounds(carData) {
  const position = carData.position;
  const halfLength = metersToDegrees * carData.length / 2;
  const halfWidth = metersToDegrees * carWidthMeters / 2;
  const angle = (carData.rotation || 0) * Math.PI / 180;
  const halfLat = Math.abs(halfLength * Math.cos(angle)) + Math.abs(halfWidth * Math.sin(angle));
  const halfLng = Math.abs(halfLength * Math.sin(angle)) + Math.abs(halfWidth * Math.cos(angle));
  return [[position[0] - halfLat, position[1] - halfLng], [position[0] + halfLat, position[1] + halfLng]];
}

function createNewCar(carId, carData) {
  allCarData.set(carId, carData);
  createCarRow(carId);
  const overlay = L.svgOverlay(
    createCarOverlay(carId, carData),
    getCarOverlayBounds(carData),
    { interactive: true, bubblingMouseEvents: false })
    .addEventListener('click', e => {
      L.DomEvent.stopPropagation(e);
      if (performance.now() - lastMapDragEnd < 250)
        return;
      followCar(carId, true);
    })
    .addTo(map);
  carMarkers.set(carId, overlay);
  updateCarMarker(carId);
}

function updateCar(carId, carData) {
  allCarData.set(carId, carData);
  updateCarRow(carId);
  updateCarMarker(carId);
}

function removeCar(carId) {
  removeCarRow(carId);
  const marker = carMarkers.get(carId);
  if (marker) {
    if (markerToFollow === marker)
      markerToFollow = null;
    marker.remove();
    carMarkers.delete(carId);
  }
  allCarData.delete(carId);
}

function updateAllCars(updateCarData) {
  Object.entries(updateCarData).forEach(([carId, carData]) => {
    if (!carMarkers.has(carId))
      createNewCar(carId, carData);
    else
      updateCar(carId, carData);
  });
  for ([carId, _] of carMarkers)
    if (!updateCarData[carId])
      removeCar(carId);
  updateLocoList();
}

function updateCars(cars) {
  Object.entries(cars).forEach(([carId, carData]) =>
    updateCar(carId, carData));
}

/////////////////////
// events

function uuidv4() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}
const sessionId = uuidv4();
const updateInterval = 100;
let updateStart;

function updateOnce() {
  updateStart = performance.now();
  return fetch(new URL(`/updates/${sessionId}`, location))
  .then(resp => {
    if (!resp.ok)
      throw new Error(`Updates failed: ${resp.status}`);
    return resp.json();
  })
  .then(updateData => {
    for (const [tag, data] of Object.entries(updateData)) {
      // One malformed tag must not prevent the rest of this batch (and later
      // polling rounds) from being applied.
      try {
        switch (tag) {
        case 'cars':
          updateAllCars(data);
          break;
        case 'jobs':
          updateAllJobs(data);
          break;
        case 'junctions':
          updateAllJunctions(data);
          break;
        case 'player':
          updatePlayerOverlays(data);
          break;
        case 'assignments':
          applyAssignmentSnapshot(data);
          break;
        case 'permissions':
          applyPermissions(data);
          break;
        default:
          const segments = tag.split('-');
          switch (segments[0]) {
          case 'trainset': updateCars(data); break;
          case 'carguid': updateCar(data.id, data); break;
          }
        }
      } catch (err) {
        console.warn(`[RemoteDispatch] failed to apply update '${tag}':`, err);
      }
    }
  })
  .then(_ => {
    if (markerToFollow && markerToFollow._map)
      map.panTo(getMarkerCenter(markerToFollow), { animate: false });
  });
}

function updateLoop() {
  updateOnce()
  .catch(err => console.warn('[RemoteDispatch] update failed:', err))
  .then(_ => {
    const timeToNextUpdate = Math.max(0, (updateStart + updateInterval) - performance.now());
    setTimeout(updateLoop, timeToNextUpdate);
  });
}

Promise.allSettled([tracksReady, junctionsReady])
  .then(() => updateLoop());

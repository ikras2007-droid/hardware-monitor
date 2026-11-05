const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const si = require('systeminformation');

let mainWindow = null;
let ohmProcess = null;
let pollTimeout = null;
let isPollingActive = false;

// Кэш статических характеристик оборудования (опрашиваются только 1 раз при старте!)
let staticHardware = {
  cpuBrand: 'Процессор',
  gpuName: 'Видеоадаптер',
  primaryDiskName: 'NVMe SSD',
  diskSizeGb: null
};

// Кэш для температуры NVMe из Windows Storage API
let cachedNvmeTemp = null;
let lastNvmePollTime = 0;

// Безопасное завершение процессов OHM без запуска cmd.exe
function killExistingOHM() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/F', '/IM', 'OpenHardwareMonitor.exe', '/T'], () => resolve());
    } else {
      resolve();
    }
  });
}

// Запуск фонового процесса OpenHardwareMonitor
function startOHM() {
  const ohmPath = path.join(__dirname, 'bin', 'ohm', 'OpenHardwareMonitor.exe');
  try {
    ohmProcess = spawn(ohmPath, [], {
      windowsHide: true,
      detached: false,
      stdio: 'ignore'
    });
    ohmProcess.on('error', (err) => {
      console.warn('[OHM] Ошибка запуска OpenHardwareMonitor.exe:', err.message);
    });
  } catch (err) {
    console.warn('[OHM] Исключение при запуске:', err.message);
  }
}

// Инициализация статических характеристик (выполняется 1 раз при старте)
async function initStaticHardwareInfo() {
  try {
    const [cpuInfo, gfxInfo, diskInfo] = await Promise.all([
      si.cpu(),
      si.graphics(),
      si.diskLayout()
    ]);

    if (cpuInfo) {
      staticHardware.cpuBrand = `${cpuInfo.manufacturer || ''} ${cpuInfo.brand || ''}`.trim() || 'Процессор';
    }

    if (gfxInfo?.controllers && gfxInfo.controllers.length > 0) {
      staticHardware.gpuName = gfxInfo.controllers[0].model || 'Видеоадаптер';
    }

    if (diskInfo && diskInfo.length > 0) {
      const nvme = diskInfo.find(d => /nvme|ssd|pcie/i.test(d.type || '') || /nvme/i.test(d.interfaceType || '') || /ssd|nvme/i.test(d.name || '')) || diskInfo[0];
      if (nvme) {
        staticHardware.primaryDiskName = nvme.name || 'NVMe SSD';
        staticHardware.diskSizeGb = nvme.size ? Math.round(nvme.size / (1024 ** 3)) : null;
      }
    }
  } catch (err) {
    console.error('[StaticHW] Ошибка инициализации оборудования:', err.message);
  }
}

// Опрос температуры NVMe через PowerShell раз в 12 секунд (устраняет пики нагрузки CPU)
function pollNvmeViaPowerShell() {
  const now = Date.now();
  if (now - lastNvmePollTime < 12000) return;
  lastNvmePollTime = now;

  if (process.platform !== 'win32') return;

  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    'Get-PhysicalDisk | ForEach-Object { $c = Get-StorageReliabilityCounter -PhysicalDisk $_ -ErrorAction SilentlyContinue; if ($c -and $c.Temperature -gt 0 -and $c.Temperature -lt 130) { $c.Temperature; break } }'
  ];

  execFile('powershell.exe', psArgs, { timeout: 3000 }, (err, stdout) => {
    if (err || !stdout) return;
    const tempVal = parseInt(stdout.trim(), 10);
    if (!isNaN(tempVal) && tempVal > 0 && tempVal < 120) {
      cachedNvmeTemp = tempVal;
    }
  });
}

// Рекурсивный парсер дерева датчиков OHM
function parseOHMTree(node, result = {}) {
  if (!node) return result;

  if (!result.cpu) {
    result.cpu = { temperatures: [], clocks: [], loads: [], coreClocks: [], voltages: [], powers: [], fans: [] };
  }
  if (!result.gpu) {
    result.gpu = { name: null, temperatures: [], loads: [], fans: [], powers: [] };
  }
  if (!result.nvme) {
    result.nvme = [];
  }
  if (!result.fans) {
    result.fans = [];
  }

  function traverse(item, currentDevice, currentCategory) {
    if (!item) return;
    const title = (item.Text || '').trim();
    const valStr = (item.Value || '').trim();

    let dev = currentDevice;
    let cat = currentCategory;

    if (/Intel|AMD Ryzen|Core i|CPU/i.test(title) && !dev) dev = 'cpu';
    if (/NVIDIA|GeForce|Radeon|Intel Arc|GPU/i.test(title)) {
      dev = 'gpu';
      if (!result.gpu.name) result.gpu.name = title;
    }
    if (/NVMe|SSD|Samsung|Kingston|Crucial|WD|Kioxia|Generic Hard Disk/i.test(title)) {
      dev = 'drive';
      if (!result.nvme.find(d => d.name === title)) {
        result.nvme.push({ name: title, temp: null, usedPercent: null });
      }
    }

    if (title === 'Temperatures') cat = 'temp';
    else if (title === 'Clocks') cat = 'clock';
    else if (title === 'Load') cat = 'load';
    else if (title === 'Voltages') cat = 'volt';
    else if (title === 'Powers') cat = 'power';
    else if (title === 'Controls' || title === 'Fans') cat = 'fan';

    if (valStr) {
      const numVal = parseFloat(valStr.replace(',', '.'));
      if (!isNaN(numVal)) {
        if (cat === 'fan') {
          const isRpm = /RPM/i.test(valStr);
          const fanObj = { name: title, value: numVal, unit: isRpm ? 'RPM' : '%' };
          result.fans.push(fanObj);
          if (dev === 'cpu' || /cpu|fan\s*#?1/i.test(title)) {
            result.cpu.fans.push(fanObj);
          } else if (dev === 'gpu') {
            result.gpu.fans.push(fanObj);
          }
        }

        if (dev === 'cpu') {
          if (cat === 'temp') result.cpu.temperatures.push({ name: title, value: numVal });
          if (cat === 'volt') result.cpu.voltages.push({ name: title, value: numVal });
          if (cat === 'power') result.cpu.powers.push({ name: title, value: numVal });
          if (cat === 'load') result.cpu.loads.push({ name: title, value: numVal });
          if (cat === 'clock') {
            result.cpu.clocks.push({ name: title, value: numVal });
            if (/Core #\d+|CPU #\d+/i.test(title)) {
              result.cpu.coreClocks.push({ name: title, value: numVal });
            }
          }
        } else if (dev === 'gpu') {
          if (cat === 'temp') result.gpu.temperatures.push({ name: title, value: numVal });
          if (cat === 'load') result.gpu.loads.push({ name: title, value: numVal });
          if (cat === 'fan' && !result.gpu.fans.some(f => f.name === title)) {
            result.gpu.fans.push({ name: title, value: numVal, unit: /RPM/i.test(valStr) ? 'RPM' : '%' });
          }
          if (cat === 'power') result.gpu.powers.push({ name: title, value: numVal });
        } else if (dev === 'drive') {
          const drive = result.nvme[result.nvme.length - 1];
          if (drive) {
            if (cat === 'temp' || /Temperature|Composite/i.test(title)) drive.temp = numVal;
            if (cat === 'load' || /Used/i.test(title)) drive.usedPercent = numVal;
          }
        }
      }
    }

    if (item.Children && Array.isArray(item.Children)) {
      item.Children.forEach(child => traverse(child, dev, cat));
    }
  }

  traverse(node, null, null);
  return result;
}

async function fetchOHMData() {
  try {
    const res = await fetch('http://localhost:8085/data.json', { signal: AbortSignal.timeout(750) });
    if (!res.ok) return null;
    const json = await res.json();
    return parseOHMTree(json);
  } catch (_e) {
    return null;
  }
}

// Легковесный цикл сбора только динамических метрик (без опроса статики!)
async function collectSystemData() {
  pollNvmeViaPowerShell();

  const [ohm, siLoad, siSpeed, siFs] = await Promise.all([
    fetchOHMData(),
    si.currentLoad().catch(() => null),
    si.cpuCurrentSpeed().catch(() => null),
    si.fsSize().catch(() => null)
  ]);

  // --- Блок CPU ---
  const cpuPackageTemp = ohm?.cpu?.temperatures?.find(t => /package|total|cpu/i.test(t.name))?.value ?? null;
  const cpuVolt = ohm?.cpu?.voltages?.[0]?.value ?? null;
  const cpuPower = ohm?.cpu?.powers?.[0]?.value ?? null;
  const cpuTotalLoad = ohm?.cpu?.loads?.find(l => /total/i.test(l.name))?.value ?? (siLoad ? Math.round(siLoad.currentLoad) : null);

  const cpuFanSensor = ohm?.cpu?.fans?.find(f => /cpu/i.test(f.name)) || ohm?.cpu?.fans?.[0] || ohm?.fans?.find(f => /cpu|fan\s*#?1/i.test(f.name)) || null;

  let coreClocks = [];
  if (ohm?.cpu?.coreClocks && ohm.cpu.coreClocks.length > 0) {
    coreClocks = ohm.cpu.coreClocks.map((c, idx) => ({
      name: `Ядро #${idx + 1}`,
      clock: Math.round(c.value)
    }));
  } else if (siSpeed?.cores && siSpeed.cores.length > 0) {
    coreClocks = siSpeed.cores.map((spd, idx) => ({
      name: `Ядро #${idx + 1}`,
      clock: Math.round(spd * 1000)
    }));
  }

  // --- Блок GPU (без частот + Hot Spot) ---
  const gpuName = ohm?.gpu?.name || staticHardware.gpuName;
  const gpuCoreTemp = ohm?.gpu?.temperatures?.find(t => /core|gpu/i.test(t.name))?.value ?? null;

  let gpuHotspotTemp = ohm?.gpu?.temperatures?.find(t => /hot\s*spot|hotspot|junction|temp.*#?2/i.test(t.name))?.value ?? null;
  if (!gpuHotspotTemp && ohm?.gpu?.temperatures && ohm.gpu.temperatures.length > 1) {
    const secondary = ohm.gpu.temperatures.find(t => !/core|gpu\s*$/i.test(t.name));
    if (secondary) {
      gpuHotspotTemp = secondary.value;
    } else {
      const maxT = Math.max(...ohm.gpu.temperatures.map(t => t.value));
      if (maxT > (gpuCoreTemp || 0)) {
        gpuHotspotTemp = maxT;
      }
    }
  }

  const gpuLoad = ohm?.gpu?.loads?.find(l => /core|gpu/i.test(l.name))?.value ?? null;
  const gpuFanSensor = ohm?.gpu?.fans?.[0] || null;
  const gpuFanVal = gpuFanSensor ? Math.round(gpuFanSensor.value) : null;
  const gpuFanUnit = gpuFanSensor ? gpuFanSensor.unit : '%';
  const gpuPower = ohm?.gpu?.powers?.[0]?.value ?? null;

  // --- Блок NVMe ---
  const nvmeTemp = cachedNvmeTemp || (ohm?.nvme?.[0]?.temp ?? null);
  const primaryFs = siFs?.find(f => f.mount === 'C:' || f.mount === '/') || siFs?.[0];

  return {
    cpu: {
      brand: staticHardware.cpuBrand,
      packageTemp: cpuPackageTemp,
      totalLoad: cpuTotalLoad,
      fanSpeed: cpuFanSensor ? Math.round(cpuFanSensor.value) : null,
      fanUnit: cpuFanSensor ? cpuFanSensor.unit : 'RPM',
      voltage: cpuVolt,
      power: cpuPower,
      clocks: ohm?.cpu?.clocks || [],
      coreClocks: coreClocks
    },
    gpu: {
      name: gpuName,
      coreTemp: gpuCoreTemp,
      hotspotTemp: gpuHotspotTemp,
      load: gpuLoad,
      fanPercent: gpuFanVal,
      fanUnit: gpuFanUnit,
      power: gpuPower
    },
    nvme: {
      name: staticHardware.primaryDiskName,
      temp: nvmeTemp,
      primaryFs: primaryFs ? {
        mount: primaryFs.mount,
        sizeGb: (primaryFs.size / (1024 ** 3)).toFixed(1),
        usedGb: (primaryFs.used / (1024 ** 3)).toFixed(1),
        usePercent: primaryFs.use?.toFixed(1)
      } : null
    },
    ohmOnline: Boolean(ohm)
  };
}

// Запуск рекурсивного опроса через setTimeout (предотвращает наложение запросов)
function startPollingLoop() {
  isPollingActive = true;

  async function tick() {
    if (!isPollingActive || !mainWindow || mainWindow.isDestroyed()) return;

    try {
      const data = await collectSystemData();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('cpu-data', data);
      }
    } catch (err) {
      console.error('[Polling] Ошибка сбора телеметрии:', err.message);
    } finally {
      if (isPollingActive) {
        pollTimeout = setTimeout(tick, 1000);
      }
    }
  }

  tick();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1050,
    minHeight: 750,
    title: 'Hardware Monitor - VRM, Case, CPU, GPU & NVMe',
    backgroundColor: '#090c10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // требуется для Web Serial API в preload/renderer
    }
  });

  // Защищенный выбор Serial-порта: проверяем, что запрос исходит от нашего приложения (file://)
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (portList && portList.length > 0) {
      const arduino = portList.find(p => 
        /arduino|ch340|ftdi|usb|cp210/i.test(p.displayName || '')
      ) || portList[0];
      callback(arduino.portId);
    } else {
      callback('');
    }
  });

  // Проверка прав доступа к порту: только локальный файл file://
  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (permission === 'serial') {
      return !requestingOrigin || requestingOrigin.startsWith('file://');
    }
    return false;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial' && (!details.origin || details.origin.startsWith('file://'));
  });

  mainWindow.loadFile('index.html');

  startPollingLoop();

  mainWindow.on('closed', () => {
    mainWindow = null;
    isPollingActive = false;
    if (pollTimeout) clearTimeout(pollTimeout);
  });
}

app.whenReady().then(async () => {
  await killExistingOHM();
  startOHM();
  await initStaticHardwareInfo();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  isPollingActive = false;
  if (pollTimeout) clearTimeout(pollTimeout);
  if (ohmProcess) {
    try {
      ohmProcess.kill();
    } catch (_e) {}
  }
  killExistingOHM();
});

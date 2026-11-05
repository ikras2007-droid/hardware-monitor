const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const si = require('systeminformation');

let mainWindow = null;
let ohmProcess = null;
let pollInterval = null;

// Поиск и убийство зависших процессов OHM перед стартом
function killExistingOHM() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('taskkill /F /IM OpenHardwareMonitor.exe /T', () => resolve());
    } else {
      resolve();
    }
  });
}

// Запуск фонового OpenHardwareMonitor
function startOHM() {
  const ohmPath = path.join(__dirname, 'bin', 'ohm', 'OpenHardwareMonitor.exe');
  try {
    ohmProcess = spawn(ohmPath, [], {
      windowsHide: true,
      detached: false,
      stdio: 'ignore'
    });
    ohmProcess.on('error', (err) => {
      console.warn('[OHM] Не удалось запустить OpenHardwareMonitor.exe:', err.message);
    });
  } catch (err) {
    console.warn('[OHM] Ошибка запуска:', err.message);
  }
}

// Рекурсивный поиск датчиков в дереве OHM
function parseOHMTree(node, result = {}) {
  if (!node) return result;

  const text = node.Text || '';
  const value = node.Value || '';

  // Определяем тип узла по SensorId или типу родителя
  if (!result.cpu) result.cpu = { temperatures: [], clocks: [], loads: [], voltages: [], powers: [] };
  if (!result.gpu) result.gpu = { name: null, temperatures: [], loads: [], fans: [], powers: [] };
  if (!result.nvme) result.nvme = [];

  // Рекурсивно обходим детей
  function traverse(item, currentDevice, currentCategory) {
    if (!item) return;
    const title = (item.Text || '').trim();
    const valStr = (item.Value || '').trim();

    let dev = currentDevice;
    let cat = currentCategory;

    // Определение устройства
    if (/Intel|AMD Ryzen|Core i|CPU/i.test(title) && !dev) dev = 'cpu';
    if (/NVIDIA|GeForce|Radeon|Intel Arc|GPU/i.test(title)) {
      dev = 'gpu';
      if (!result.gpu.name) result.gpu.name = title;
    }
    if (/NVMe|SSD|Samsung|Kingston|WD|Crucial|Generic Hard Disk/i.test(title)) {
      dev = 'drive';
      if (!result.nvme.find(d => d.name === title)) {
        result.nvme.push({ name: title, temp: null, usedPercent: null });
      }
    }

    // Определение категории
    if (title === 'Temperatures') cat = 'temp';
    else if (title === 'Clocks') cat = 'clock';
    else if (title === 'Load') cat = 'load';
    else if (title === 'Voltages') cat = 'volt';
    else if (title === 'Powers') cat = 'power';
    else if (title === 'Controls') cat = 'fan';

    // Сбор значений
    if (valStr) {
      const numVal = parseFloat(valStr.replace(',', '.'));
      if (!isNaN(numVal)) {
        if (dev === 'cpu') {
          if (cat === 'temp') result.cpu.temperatures.push({ name: title, value: numVal });
          if (cat === 'clock') result.cpu.clocks.push({ name: title, value: numVal });
          if (cat === 'load') result.cpu.loads.push({ name: title, value: numVal });
          if (cat === 'volt') result.cpu.voltages.push({ name: title, value: numVal });
          if (cat === 'power') result.cpu.powers.push({ name: title, value: numVal });
        } else if (dev === 'gpu') {
          // Для GPU намеренно НЕ собираем частоты (cat === 'clock')!
          if (cat === 'temp') result.gpu.temperatures.push({ name: title, value: numVal });
          if (cat === 'load') result.gpu.loads.push({ name: title, value: numVal });
          if (cat === 'fan') result.gpu.fans.push({ name: title, value: numVal });
          if (cat === 'power') result.gpu.powers.push({ name: title, value: numVal });
        } else if (dev === 'drive') {
          const drive = result.nvme[result.nvme.length - 1];
          if (drive) {
            if (cat === 'temp' || /Temperature/i.test(title)) drive.temp = numVal;
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

// Запрос данных OHM через HTTP JSON API
async function fetchOHMData() {
  try {
    const res = await fetch('http://localhost:8085/data.json', { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const json = await res.json();
    return parseOHMTree(json);
  } catch (_e) {
    return null;
  }
}

// Главная функция сборки всей телеметрии ПК
async function collectSystemData() {
  const ohm = await fetchOHMData();

  // Дополнительно опрашиваем systeminformation как резервный/дополняющий источник
  let siCpu = null, siGpu = null, siMem = null, siDisks = null, siFs = null;
  try {
    [siCpu, siGpu, siMem, siDisks, siFs] = await Promise.all([
      si.cpu(),
      si.graphics(),
      si.mem(),
      si.diskLayout(),
      si.fsSize()
    ]);
  } catch (err) {
    console.error('[SI] Ошибка сбора:', err.message);
  }

  // --- Формируем блок CPU ---
  const cpuPackageTemp = ohm?.cpu?.temperatures?.find(t => /package|total|cpu/i.test(t.name))?.value ?? null;
  const cpuVolt = ohm?.cpu?.voltages?.[0]?.value ?? null;
  const cpuPower = ohm?.cpu?.powers?.[0]?.value ?? null;
  const cpuLoad = ohm?.cpu?.loads?.find(l => /total/i.test(l.name))?.value ?? null;

  // --- Формируем блок GPU (без частот!) ---
  const gpuName = ohm?.gpu?.name || siGpu?.controllers?.[0]?.model || 'Графический процессор';
  const gpuCoreTemp = ohm?.gpu?.temperatures?.find(t => /core|gpu/i.test(t.name))?.value ?? null;
  const gpuHotspotTemp = ohm?.gpu?.temperatures?.find(t => /hot\s*spot/i.test(t.name))?.value ?? null;
  const gpuLoad = ohm?.gpu?.loads?.find(l => /core|gpu/i.test(l.name))?.value ?? null;
  const gpuFan = ohm?.gpu?.fans?.[0]?.value ?? null;
  const gpuPower = ohm?.gpu?.powers?.[0]?.value ?? null;

  // --- Формируем блок NVMe ---
  const nvmeList = [];
  if (ohm?.nvme && ohm.nvme.length > 0) {
    ohm.nvme.forEach(d => {
      nvmeList.push({
        name: d.name,
        temp: d.temp,
        usedPercent: d.usedPercent
      });
    });
  } else if (siDisks) {
    siDisks.forEach(d => {
      if (/nvme|ssd/i.test(d.type || '') || /nvme/i.test(d.interfaceType || '') || /ssd/i.test(d.name || '')) {
        nvmeList.push({
          name: d.name || 'NVMe SSD',
          temp: d.temperature || null,
          sizeGb: d.size ? Math.round(d.size / (1024 ** 3)) : null
        });
      }
    });
  }

  // Данные файловой системы (диск C:)
  const primaryFs = siFs?.find(f => f.mount === 'C:' || f.mount === '/') || siFs?.[0];

  return {
    cpu: {
      brand: siCpu ? `${siCpu.manufacturer || ''} ${siCpu.brand || ''}`.trim() : 'Процессор',
      packageTemp: cpuPackageTemp,
      load: cpuLoad,
      voltage: cpuVolt,
      power: cpuPower,
      clocks: ohm?.cpu?.clocks || []
    },
    gpu: {
      name: gpuName,
      coreTemp: gpuCoreTemp,
      hotspotTemp: gpuHotspotTemp,
      load: gpuLoad,
      fanPercent: gpuFan,
      power: gpuPower
    },
    nvme: {
      disks: nvmeList,
      primaryFs: primaryFs ? {
        mount: primaryFs.mount,
        sizeGb: (primaryFs.size / (1024 ** 3)).toFixed(1),
        usedGb: (primaryFs.used / (1024 ** 3)).toFixed(1),
        usePercent: primaryFs.use?.toFixed(1)
      } : null
    },
    ram: {
      totalGb: siMem ? (siMem.total / (1024 ** 3)).toFixed(1) : 0,
      usedGb: siMem ? (siMem.active / (1024 ** 3)).toFixed(1) : 0,
      usedPercent: siMem ? Math.round((siMem.active / siMem.total) * 100) : 0
    },
    ohmOnline: Boolean(ohm)
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    title: 'Hardware Monitor - VRM & Telemetry',
    backgroundColor: '#0a0d14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // --- Автоматическая выдача прав Web Serial API для связи с Arduino ---
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (portList && portList.length > 0) {
      // Ищем устройство по ключевым словам или берем первое
      const arduino = portList.find(p => 
        /arduino|ch340|ftdi|usb|cp210/i.test(p.displayName || '')
      ) || portList[0];
      callback(arduino.portId);
    } else {
      callback('');
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'serial';
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial';
  });

  mainWindow.loadFile('index.html');

  // Периодический опрос системных датчиков каждые 1000 мс
  pollInterval = setInterval(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const data = await collectSystemData();
      mainWindow.webContents.send('cpu-data', data);
    }
  }, 1000);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (pollInterval) clearInterval(pollInterval);
  });
}

app.whenReady().then(async () => {
  await killExistingOHM();
  startOHM();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  if (pollInterval) clearInterval(pollInterval);
  if (ohmProcess) {
    try {
      ohmProcess.kill();
    } catch (_e) {}
  }
  // Контрольная очистка процесса OHM
  killExistingOHM();
});

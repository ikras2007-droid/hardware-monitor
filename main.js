const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const si = require('systeminformation');

let mainWindow;
let ohmProcess = null;
let cpuBrandName = 'CPU';

// Скрытый запуск Open Hardware Monitor
function startOhmProcess() {
  const isPackaged = app.isPackaged;
  const basePath = isPackaged 
    ? path.join(process.resourcesPath, 'bin', 'ohm') 
    : path.join(__dirname, 'bin', 'ohm');
    
  const execPath = path.join(basePath, 'OpenHardwareMonitor.exe');

  try {
    ohmProcess = spawn(execPath, [], {
      windowsHide: true,
      stdio: 'ignore'
    });

    ohmProcess.on('error', (err) => {
      console.warn('OHM не найден:', execPath, err.message);
    });
  } catch (err) {
    console.warn('Не удалось запустить процесс OHM:', err.message);
  }
}

// Запрос JSON из OHM
function fetchOhmJson() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:8085/data.json', { timeout: 400 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Извлечение температуры, кулера и частот каждого ядра
function extractCpuMetricsFromOhm(rootNode) {
  if (!rootNode) return { temp: null, fanRpm: null, coreClocks: [] };

  let packageTemp = null;
  const coreTemps = [];
  const coreClocksMap = new Map(); // Карта "Номер ядра" -> Частота
  let cpuFanRpm = null;

  function traverse(node) {
    if (!node) return;

    const text = (node.Text || '').toLowerCase();
    const valStr = node.Value || '';

    // 1. Температуры (°C)
    if (valStr.includes('°C')) {
      const val = parseFloat(valStr.replace(',', '.'));
      if (!isNaN(val) && val > 0) {
        if (text.includes('cpu package') || text.includes('cpu total')) {
          packageTemp = val;
        } else if (text.includes('core #') || text.includes('cpu core')) {
          coreTemps.push(val);
        }
      }
    }

    // 2. Частоты ядер (MHz)
    if (valStr.toLowerCase().includes('mhz')) {
      const clockVal = parseFloat(valStr.replace(',', '.').replace(/[^0-9.]/g, ''));
      if (!isNaN(clockVal) && clockVal > 100) {
        // Ищем соответствие "core #1", "core #2" и т.д.
        const match = text.match(/core\s*#(\d+)/i);
        if (match && !text.includes('bus')) {
          const coreNum = parseInt(match[1], 10);
          coreClocksMap.set(coreNum, (clockVal / 1000.0).toFixed(2));
        }
      }
    }

    // 3. Тахометр кулера (RPM)
    if (valStr.toLowerCase().includes('rpm')) {
      const rpmVal = parseInt(valStr.replace(/\D/g, ''), 10);
      if (!isNaN(rpmVal)) {
        if (text.includes('cpu fan') || text.includes('cpu') || text.includes('fan #1')) {
          cpuFanRpm = rpmVal;
        } else if (cpuFanRpm === null) {
          cpuFanRpm = rpmVal;
        }
      }
    }

    if (node.Children && Array.isArray(node.Children)) {
      for (const child of node.Children) {
        traverse(child);
      }
    }
  }

  traverse(rootNode);

  // Сортируем частоты по номерам ядер (1, 2, 3...)
  const sortedClocks = Array.from(coreClocksMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(entry => entry[1]);

  let finalTemp = null;
  if (packageTemp !== null) {
    finalTemp = packageTemp;
  } else if (coreTemps.length > 0) {
    finalTemp = Math.max(...coreTemps);
  }

  return { 
    temp: finalTemp, 
    fanRpm: cpuFanRpm, 
    coreClocks: sortedClocks 
  };
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    backgroundColor: '#0b0c10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  try {
    const cpuInfo = await si.cpu();
    let name = cpuInfo.brand || cpuInfo.model || 'CPU';
    name = name.replace(/@.*$/, '')
               .replace(/\(R\)/gi, '')
               .replace(/\(TM\)/gi, '')
               .replace(/CPU/gi, '')
               .trim();
    cpuBrandName = name || 'Процессор';
  } catch (e) {
    console.error('Ошибка названия CPU:', e);
  }

  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (portList && portList.length > 0) {
      const port = portList.find(p => p.portName === 'COM3') || portList[0];
      callback(port.portId);
    } else {
      callback('');
    }
  });

  mainWindow.loadFile('index.html');
}

setInterval(async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      const [loadData, speedData, ohmData, stdTemp] = await Promise.all([
        si.currentLoad(),
        si.cpuCurrentSpeed(),
        fetchOhmJson(),
        si.cpuTemperature()
      ]);

      let cpuT = 0;
      let cpuFan = 0;
      let clocks = [];

      if (ohmData) {
        const metrics = extractCpuMetricsFromOhm(ohmData);
        if (metrics.temp) cpuT = metrics.temp;
        if (metrics.fanRpm !== null) cpuFan = metrics.fanRpm;
        if (metrics.coreClocks && metrics.coreClocks.length > 0) {
          clocks = metrics.coreClocks;
        }
      }

      // Резервный сбор частот по ядрам через systeminformation
      if (clocks.length === 0 && speedData.cores && speedData.cores.length > 0) {
        clocks = speedData.cores.map(c => c.toFixed(2));
      }

      if (!cpuT || cpuT <= 0) {
        cpuT = stdTemp.main || stdTemp.max || 0;
      }

      mainWindow.webContents.send('cpu-data', {
        brand: cpuBrandName,
        temp: Number(cpuT) || 0,
        load: Math.round(loadData.currentLoad || 0),
        fan: cpuFan,
        clocks: clocks // Массив частот всех ядер: ["2.50", "2.80", ...]
      });
    } catch (e) {
      console.error('Ошибка телеметрии:', e);
    }
  }
}, 1000);

app.whenReady().then(() => {
  startOhmProcess();
  createWindow();
});

app.on('will-quit', () => {
  if (ohmProcess) {
    ohmProcess.kill();
    ohmProcess = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
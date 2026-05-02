import { listServers, getServerMetrics } from './servers.js';
import { audit } from './audit.js';

export function initMonitoring(app) {
  console.log('Health monitor service started.');

  setInterval(async () => {
    const servers = listServers();
    
    for (const s of servers) {
      const history = getServerMetrics(s.name);
      if (!history || history.length === 0) continue;

      const latest = history[history.length - 1];
      const alerts = [];

      // Alert if CPU is over 90%
      if (latest.cpu > 90) {
        alerts.push(`High CPU usage: ${latest.cpu.toFixed(1)}%`);
      }

      // Alert if RAM usage is over 95% of allocated maximum
      const maxRamBytes = parseRamToBytes(s.ramMax || '4G'); 
      if (latest.memory > (maxRamBytes * 0.95)) {
        alerts.push(`Critical Memory: ${Math.round(latest.memory / 1024 / 1024)}MB used`);
      }

      if (alerts.length > 0) {
        // Create a system-level audit log entry
        const sysReq = { user: { username: 'SYSTEM' }, ip: '127.0.0.1' };
        
        for (const msg of alerts) {
          // This will show up in your audit.html automatically!
          audit(sysReq, 'server.health_alert', s.name, { issue: msg });
          console.warn(`[HEALTH ALERT] ${s.name}: ${msg}`);
        }
      }
    }
  }, 60000); // Check every 60 seconds
}

function parseRamToBytes(ramStr) {
  const unit = ramStr.slice(-1).toUpperCase();
  const val = parseInt(ramStr.slice(0, -1), 10);
  if (unit === 'G') return val * 1024 * 1024 * 1024;
  if (unit === 'M') return val * 1024 * 1024;
  return val;
}
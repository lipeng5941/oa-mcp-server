import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const WEBDAEMON = 'http://127.0.0.1:10086';
const SESSION = 'oa-mcp';
const BASE_URL = process.env.OA_BASE_URL || 'https://oatest.sgscf.cn/oamgr';

export async function callApi(apiPath: string, body: any = {}): Promise<any> {
  const url = `${BASE_URL}${apiPath}`;
  
  const fetchCode = `
    (async () => {
      const r = await fetch('${url}', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(${JSON.stringify(body)}),
        credentials: 'include'
      });
      return JSON.stringify(await r.json());
    })()
  `;

  return new Promise((resolve, reject) => {
    const reqFile = path.join(process.env.TEMP || '/tmp', `mcp-req-${Date.now()}.json`);
    fs.writeFileSync(reqFile, JSON.stringify({
      action: 'evaluate',
      args: { code: fetchCode },
      session: SESSION
    }));

    exec(`curl.exe -s -X POST ${WEBDAEMON}/command -H "Content-Type: application/json" --data-binary "@${reqFile}"`, (err, stdout) => {
      try { fs.unlinkSync(reqFile); } catch(e) {}
      
      if (err) return reject(err);
      
      try {
        const result = JSON.parse(stdout);
        if (result.ok) {
          resolve(JSON.parse(result.data.value));
        } else {
          reject(new Error(result.error?.message || 'WebBridge error'));
        }
      } catch(e) {
        reject(new Error('Parse error'));
      }
    });
  });
}
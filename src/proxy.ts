import express from 'express';
import { exec } from 'child_process';
import * as path from 'path';

const app = express();
app.use(express.json());

const WEBDAEMON = 'http://127.0.0.1:10086';
const SESSION = 'oa-proxy';

// 代理请求：通过 WebBridge 在浏览器中执行 fetch
app.all('/proxy', async (req, res) => {
  const { url, method = 'GET', body, headers = {} } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  // 构建 fetch 代码
  const fetchCode = `
    (async () => {
      const r = await fetch('${url}', {
        method: '${method}',
        headers: ${JSON.stringify(headers)},
        ${body ? `body: JSON.stringify(${JSON.stringify(body)}),` : ''}
        credentials: 'include'
      });
      const data = await r.json();
      return JSON.stringify(data);
    })()
  `;

  // 写入请求文件
  const reqFile = path.join(process.env.TEMP || '/tmp', `proxy-req-${Date.now()}.json`);
  require('fs').writeFileSync(reqFile, JSON.stringify({
    action: 'evaluate',
    args: { code: fetchCode },
    session: SESSION
  }));

  // 调用 WebBridge
  exec(`curl.exe -s -X POST ${WEBDAEMON}/command -H "Content-Type: application/json" --data-binary "@${reqFile}"`, async (err, stdout) => {
    try { require('fs').unlinkSync(reqFile); } catch(e) {}
    
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    try {
      const result = JSON.parse(stdout);
      if (result.ok) {
        res.json(JSON.parse(result.data.value));
      } else {
        res.status(500).json({ error: result.error });
      }
    } catch(e) {
      res.status(500).json({ error: 'parse error', raw: stdout });
    }
  });
});

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`OA Proxy running on http://localhost:${PORT}`);
});
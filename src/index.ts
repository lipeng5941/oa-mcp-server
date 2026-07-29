#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { searchOffice, getOfficeDetail } from './api/office';
import { searchRoom, getRoomDetail } from './api/room';
import { OfficeSearchParams } from './types/office';
import { RoomSearchParams } from './types/room';

// ============ MCP Server ============
const mcpServer = new McpServer({
  name: 'sgs-oa-mcp',
  version: '1.0.0'
});

mcpServer.registerTool('search_office', {
  title: '查询办公场所',
  description: '查询山钢资本数智办公平台的办公场所列表。可按名称、地址筛选。返回场所ID、名称、地址、所属机构等信息。',
  inputSchema: {
    officenm: z.string().optional().describe('办公场所名称'),
    address: z.string().optional().describe('地址'),
    current: z.number().default(1).describe('页码'),
    size: z.number().default(15).describe('每页条数')
  }
}, async ({ officenm, address, current, size }) => {
  try {
    const result = await searchOffice({ officenm, address, current, size });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: 'text' as const, text: `查询失败：${error.message}` }], isError: true };
  }
});

mcpServer.registerTool('search_room', {
  title: '查询会议室',
  description: '查询会议室列表。可按名称、容纳人数、楼宇筛选。',
  inputSchema: {
    roomnm: z.string().optional().describe('会议室名称'),
    capacity: z.number().optional().describe('最低容纳人数'),
    building: z.string().optional().describe('楼宇'),
    current: z.number().default(1).describe('页码'),
    size: z.number().default(15).describe('每页条数')
  }
}, async ({ roomnm, capacity, building, current, size }) => {
  try {
    const result = await searchRoom({ roomnm, capacity, building, current, size });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: 'text' as const, text: `查询失败：${error.message}` }], isError: true };
  }
});

mcpServer.registerTool('get_office_detail', {
  title: '获取办公场所详情',
  description: '根据场所ID获取详细信息',
  inputSchema: {
    officeid: z.string().describe('办公场所ID')
  }
}, async ({ officeid }) => {
  try {
    const result = await getOfficeDetail(officeid);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: 'text' as const, text: `查询失败：${error.message}` }], isError: true };
  }
});

mcpServer.registerTool('get_room_detail', {
  title: '获取会议室详情',
  description: '根据会议室ID获取详细信息',
  inputSchema: {
    roomid: z.string().describe('会议室ID')
  }
}, async ({ roomid }) => {
  try {
    const result = await getRoomDetail(roomid);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error: any) {
    return { content: [{ type: 'text' as const, text: `查询失败：${error.message}` }], isError: true };
  }
});

// ============ 传输方式 ============
const transport = process.argv[2] || 'stdio';

if (transport === 'stdio') {
  // 本地 stdio 模式
  const stdioTransport = new StdioServerTransport();
  mcpServer.connect(stdioTransport).then(() => {
    console.error('SGS OA MCP Server running on stdio');
  });
} else {
  // HTTP 远程模式
  const app = express();
  app.use(express.json());

  const API_KEYS = new Set(['dev-key-001', 'prod-key-002']);
  app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'] as string || req.headers['authorization']?.replace('Bearer ', '');
    if (!apiKey || !API_KEYS.has(apiKey)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // MCP 端点
  app.post('/mcp', async (req, res) => {
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => httpTransport.close());
    await mcpServer.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  // REST API（给非 MCP Agent）
  app.post('/api/v1/tools/search_office', async (req, res) => {
    try {
      const params: OfficeSearchParams = {
        officenm: req.body.officenm,
        address: req.body.address,
        current: req.body.current || 1,
        size: req.body.size || 15
      };
      const result = await searchOffice(params);
      res.json({ success: true, data: result.result.rows, total: result.result.totalCount });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/v1/tools/get_office_detail', async (req, res) => {
    try {
      const result = await getOfficeDetail(req.body.officeid);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/v1/tools/search_room', async (req, res) => {
    try {
      const params: RoomSearchParams = {
        roomnm: req.body.roomnm,
        capacity: req.body.capacity,
        building: req.body.building,
        current: req.body.current || 1,
        size: req.body.size || 15
      };
      const result = await searchRoom(params);
      res.json({ success: true, data: result.result.rows, total: result.result.totalCount });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/v1/tools/get_room_detail', async (req, res) => {
    try {
      const result = await getRoomDetail(req.body.roomid);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/v1/tools', (req, res) => {
    res.json({
      success: true,
      tools: [
        { name: 'search_office', description: '查询办公场所列表', params: { officenm: 'string (可选)', address: 'string (可选)', current: 'number', size: 'number' } },
        { name: 'get_office_detail', description: '获取办公场所详情', params: { officeid: 'string (必填)' } },
        { name: 'search_room', description: '查询会议室列表', params: { roomnm: 'string (可选)', capacity: 'number (可选)', building: 'string (可选)', current: 'number', size: 'number' } },
        { name: 'get_room_detail', description: '获取会议室详情', params: { roomid: 'string (必填)' } }
      ]
    });
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`SGS OA MCP Server running on http://0.0.0.0:${PORT}`);
  });
}
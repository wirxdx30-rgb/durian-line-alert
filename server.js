'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'alert-state.json');

const LINE_CHANNEL_SECRET =
  process.env.LINE_CHANNEL_SECRET || '';
const LINE_CHANNEL_ACCESS_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const SYNC_API_KEY =
  process.env.SYNC_API_KEY || '';

const LINK_CODE_TTL_MS = 15 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultState() {
  return {
    gardens: [],
    gardensByAccount: {},
    lineLinks: {},
    pendingLineCodes: {},
    alertHistory: [],
    lastAutoAlertByAccount: {},
  };
}

function loadState() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return defaultState();
    }

    const parsed = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8'),
    );

    return {
      ...defaultState(),
      ...parsed,
      gardensByAccount:
        parsed.gardensByAccount || {},
      lineLinks:
        parsed.lineLinks || {},
      pendingLineCodes:
        parsed.pendingLineCodes || {},
      alertHistory:
        Array.isArray(parsed.alertHistory)
          ? parsed.alertHistory
          : [],
      lastAutoAlertByAccount:
        parsed.lastAutoAlertByAccount || {},
    };
  } catch (error) {
    console.error('LOAD STATE ERROR:', error);
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  const tempFile = `${DATA_FILE}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(state, null, 2),
    'utf8',
  );

  fs.renameSync(tempFile, DATA_FILE);
}

function cleanPhone(value) {
  return String(value || '')
    .replace(/[^0-9A-Za-z]/g, '')
    .trim();
}

function jsonError(res, status, message) {
  return res.status(status).json({
    ok: false,
    error: message,
  });
}

function requireSyncKey(req, res, next) {
  if (!SYNC_API_KEY) {
    return jsonError(
      res,
      500,
      'SYNC_API_KEY ยังไม่ได้ตั้งค่า',
    );
  }

  const key = req.get('x-sync-key') || '';

  if (
    !crypto.timingSafeEqual(
      Buffer.from(key),
      Buffer.from(SYNC_API_KEY),
    )
  ) {
    return jsonError(
      res,
      401,
      'รหัสเชื่อมต่อไม่ถูกต้อง',
    );
  }

  next();
}

async function pushLineMessage(userId, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    throw new Error(
      'LINE_CHANNEL_ACCESS_TOKEN ยังไม่ได้ตั้งค่า',
    );
  }

  const response = await fetch(
    'https://api.line.me/v2/bot/message/push',
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: userId,
        messages: [
          {
            type: 'text',
            text: String(text).slice(0, 5000),
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `LINE API ${response.status}: ${body}`,
    );
  }
}

async function replyLineMessage(replyToken, text) {
  if (!replyToken) {
    return;
  }

  const response = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: 'text',
            text: String(text).slice(0, 5000),
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    console.error(
      'LINE REPLY ERROR:',
      response.status,
      body,
    );
  }
}

function verifyLineSignature(rawBody, signature) {
  if (
    !LINE_CHANNEL_SECRET ||
    !signature ||
    !rawBody
  ) {
    return false;
  }

  const expected = crypto
    .createHmac(
      'sha256',
      LINE_CHANNEL_SECRET,
    )
    .update(rawBody)
    .digest('base64');

  const receivedBuffer =
    Buffer.from(signature);
  const expectedBuffer =
    Buffer.from(expected);

  return (
    receivedBuffer.length ===
      expectedBuffer.length &&
    crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer,
    )
  );
}

function cleanupExpiredCodes() {
  const now = Date.now();

  for (
    const [code, item]
    of Object.entries(state.pendingLineCodes)
  ) {
    if (
      !item ||
      Number(item.expiresAt || 0) <= now
    ) {
      delete state.pendingLineCodes[code];
    }
  }
}

function createLinkCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'DUR-';

    for (let index = 0; index < 6; index++) {
      code += chars[
        crypto.randomInt(0, chars.length)
      ];
    }

    if (!state.pendingLineCodes[code]) {
      return code;
    }
  }

  throw new Error(
    'ไม่สามารถสร้างรหัสเชื่อมต่อได้',
  );
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'x-sync-key',
    'x-line-signature',
  ],
}));

// ต้องประกาศ Webhook ก่อน express.json()
// เพื่อเก็บ raw body สำหรับตรวจลายเซ็น LINE
app.post(
  '/line/webhook',
  express.raw({
    type: 'application/json',
    limit: '1mb',
  }),
  async (req, res) => {
    const rawBody = req.body;
    const signature =
      req.get('x-line-signature') || '';

    if (
      !verifyLineSignature(
        rawBody,
        signature,
      )
    ) {
      return jsonError(
        res,
        401,
        'LINE signature ไม่ถูกต้อง',
      );
    }

    let payload;

    try {
      payload = JSON.parse(
        rawBody.toString('utf8'),
      );
    } catch (_) {
      return jsonError(
        res,
        400,
        'รูปแบบ Webhook ไม่ถูกต้อง',
      );
    }

    // ตอบ 200 ให้ LINE ก่อน
    res.status(200).json({ ok: true });

    cleanupExpiredCodes();

    for (const event of payload.events || []) {
      try {
        const userId =
          event?.source?.userId || '';

        if (!userId) {
          continue;
        }

        if (
          event.type === 'message' &&
          event.message?.type === 'text'
        ) {
          const text = String(
            event.message.text || '',
          )
            .trim()
            .toUpperCase();

          const pending =
            state.pendingLineCodes[text];

          if (
            pending &&
            Number(pending.expiresAt) >
              Date.now()
          ) {
            const phone =
              cleanPhone(pending.phone);

            state.lineLinks[phone] = {
              userId,
              linkedAt:
                new Date().toISOString(),
            };

            delete state.pendingLineCodes[text];
            saveState();

            await replyLineMessage(
              event.replyToken,
              'เชื่อมต่อ Durian Alert สำเร็จแล้ว ✅\n'
                + 'จากนี้คุณจะรับการแจ้งเตือนสภาพอากาศของสวนผ่าน LINE ได้',
            );

            continue;
          }

          if (
            text === 'สถานะ' ||
            text === 'STATUS'
          ) {
            const linkedPhone =
              Object.entries(state.lineLinks)
                .find(
                  ([, item]) =>
                    item?.userId === userId,
                )?.[0];

            await replyLineMessage(
              event.replyToken,
              linkedPhone
                ? `LINE นี้เชื่อมต่อกับบัญชี ${linkedPhone} แล้ว ✅`
                : 'LINE นี้ยังไม่ได้เชื่อมต่อกับแอป Durian Alert',
            );

            continue;
          }

          await replyLineMessage(
            event.replyToken,
            'กรุณาส่งรหัสเชื่อมต่อที่ขึ้นต้นด้วย DUR- จากแอป Durian Alert',
          );
        }

        if (event.type === 'follow') {
          await replyLineMessage(
            event.replyToken,
            'ขอบคุณที่เพิ่มเพื่อน 🌿\n'
              + 'กลับไปที่แอป Durian Alert กดเชื่อมต่อ LINE แล้วส่งรหัส DUR-xxxxxx มาที่แชตนี้',
          );
        }
      } catch (error) {
        console.error(
          'WEBHOOK EVENT ERROR:',
          error,
        );
      }
    }
  },
);

app.use(express.json({
  limit: '1mb',
}));

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'durian-line-alert',
    version: '2.0.0',
    lineConfigured: Boolean(
      LINE_CHANNEL_SECRET &&
      LINE_CHANNEL_ACCESS_TOKEN,
    ),
    dataFile: DATA_FILE,
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

app.post('/line/link-code', (req, res) => {
  const phone =
    cleanPhone(req.body?.phone);

  if (!phone) {
    return jsonError(
      res,
      400,
      'กรุณาระบุเบอร์โทร',
    );
  }

  cleanupExpiredCodes();

  // ลบรหัสเก่าของบัญชีเดียวกัน
  for (
    const [code, item]
    of Object.entries(state.pendingLineCodes)
  ) {
    if (
      cleanPhone(item?.phone) === phone
    ) {
      delete state.pendingLineCodes[code];
    }
  }

  const code = createLinkCode();

  state.pendingLineCodes[code] = {
    phone,
    createdAt:
      new Date().toISOString(),
    expiresAt:
      Date.now() + LINK_CODE_TTL_MS,
  };

  saveState();

  res.json({
    ok: true,
    code,
    expiresInSeconds:
      Math.floor(LINK_CODE_TTL_MS / 1000),
    lineOfficialAccountId:
      process.env.LINE_OA_ID ||
      '@943krgpw',
  });
});

app.get('/line/status', (req, res) => {
  const phone =
    cleanPhone(req.query.phone);

  if (!phone) {
    return jsonError(
      res,
      400,
      'กรุณาระบุเบอร์โทร',
    );
  }

  const link = state.lineLinks[phone];

  res.json({
    ok: true,
    connected: Boolean(link?.userId),
    linkedAt: link?.linkedAt || null,
  });
});

app.post('/line/test', async (req, res) => {
  const phone =
    cleanPhone(req.body?.phone);

  if (!phone) {
    return jsonError(
      res,
      400,
      'กรุณาระบุเบอร์โทร',
    );
  }

  const link = state.lineLinks[phone];

  if (!link?.userId) {
    return jsonError(
      res,
      404,
      'บัญชีนี้ยังไม่ได้เชื่อมต่อ LINE',
    );
  }

  try {
    await pushLineMessage(
      link.userId,
      'ทดสอบแจ้งเตือนจาก Durian Alert สำเร็จ ✅\n'
        + 'ระบบพร้อมส่งข้อมูลฝน ลม พายุ และความเสี่ยงของสวนแล้ว 🌿',
    );

    res.json({
      ok: true,
      message: 'ส่งข้อความทดสอบสำเร็จ',
    });
  } catch (error) {
    console.error('LINE TEST ERROR:', error);

    jsonError(
      res,
      502,
      error.message ||
        'ส่งข้อความ LINE ไม่สำเร็จ',
    );
  }
});

app.post('/line/disconnect', (req, res) => {
  const phone =
    cleanPhone(req.body?.phone);

  if (!phone) {
    return jsonError(
      res,
      400,
      'กรุณาระบุเบอร์โทร',
    );
  }

  delete state.lineLinks[phone];
  saveState();

  res.json({
    ok: true,
    connected: false,
  });
});

// รองรับ Flutter รุ่นเดิมชั่วคราว
app.post('/send-test-line', async (req, res) => {
  const fallbackUserId =
    process.env.LINE_USER_ID || '';

  if (!fallbackUserId) {
    return jsonError(
      res,
      400,
      'ยังไม่มี LINE_USER_ID หรือบัญชีที่เชื่อมต่อ',
    );
  }

  try {
    await pushLineMessage(
      fallbackUserId,
      'ทดสอบระบบแจ้งเตือน Durian Alert สำเร็จ ✅',
    );

    res.json({ ok: true });
  } catch (error) {
    jsonError(res, 502, error.message);
  }
});

app.post('/send-line-alert', async (req, res) => {
  const fallbackUserId =
    process.env.LINE_USER_ID || '';

  if (!fallbackUserId) {
    return jsonError(
      res,
      400,
      'ยังไม่มี LINE_USER_ID',
    );
  }

  const body = req.body || {};

  const message = [
    '⚠️ แจ้งเตือนสภาพอากาศสวนทุเรียน',
    body.garden
      ? `สวน: ${body.garden}`
      : null,
    body.title
      ? `เหตุการณ์: ${body.title}`
      : null,
    body.description || null,
    body.advice
      ? `คำแนะนำ: ${body.advice}`
      : null,
    body.temperature
      ? `อุณหภูมิ: ${body.temperature}`
      : null,
    body.humidity
      ? `ความชื้น: ${body.humidity}`
      : null,
    body.rain
      ? `โอกาสฝน: ${body.rain}`
      : null,
    body.wind
      ? `ลม: ${body.wind}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    await pushLineMessage(
      fallbackUserId,
      message,
    );

    res.json({ ok: true });
  } catch (error) {
    jsonError(res, 502, error.message);
  }
});

app.post(
  '/sync-gardens',
  requireSyncKey,
  (req, res) => {
    const gardens =
      Array.isArray(req.body?.gardens)
        ? req.body.gardens
        : [];

    const phone =
      cleanPhone(req.body?.phone);

    if (phone) {
      state.gardensByAccount[phone] =
        gardens;
    }

    // เก็บรูปแบบเก่าไว้เพื่อไม่ให้ระบบเดิมพัง
    state.gardens = gardens;
    saveState();

    res.json({
      ok: true,
      gardenCount: gardens.length,
    });
  },
);

app.get(
  '/gardens',
  requireSyncKey,
  (req, res) => {
    const phone =
      cleanPhone(req.query.phone);

    const gardens =
      phone
        ? state.gardensByAccount[phone] || []
        : state.gardens || [];

    res.json({
      ok: true,
      gardens,
      gardenCount: gardens.length,
    });
  },
);

app.post('/check-rain-now', (req, res) => {
  res.json({
    ok: true,
    message:
      'ระบบตรวจอากาศอัตโนมัติจะเพิ่มในขั้นถัดไป',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('DURIAN ALERT SERVER RUNNING');
  console.log(`PORT: ${PORT}`);
  console.log(`DATA FILE: ${DATA_FILE}`);
  console.log(
    `LINE CONFIGURED: ${
      Boolean(
        LINE_CHANNEL_SECRET &&
        LINE_CHANNEL_ACCESS_TOKEN,
      )
    }`,
  );
});

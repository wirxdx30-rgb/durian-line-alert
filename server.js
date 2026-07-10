const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;

const RAIN_THRESHOLD = Number(
  process.env.RAIN_PROBABILITY_THRESHOLD || 60
);

let gardens = [];

try {
  gardens = JSON.parse(process.env.GARDENS_JSON || '[]');
} catch (error) {
  console.error('GARDENS_JSON format is invalid');
}

// เก็บรายการที่เคยส่ง ป้องกันส่งซ้ำระหว่างที่ Server ยังทำงาน
const sentAlerts = new Map();

async function sendLine(text) {
  if (!LINE_TOKEN || LINE_TOKEN === 'PUT_TOKEN_HERE') {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not set');
  }

  if (!LINE_USER_ID || !LINE_USER_ID.startsWith('U')) {
    throw new Error('LINE_USER_ID is not set correctly');
  }

  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to: LINE_USER_ID,
      messages: [
        {
          type: 'text',
          text: text,
        },
      ],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LINE_TOKEN}`,
      },
      timeout: 20000,
    }
  );
}

function thaiTime(date) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

async function getForecast(garden) {
  const response = await axios.get(
    'https://api.open-meteo.com/v1/forecast',
    {
      params: {
        latitude: garden.latitude,
        longitude: garden.longitude,
        hourly: [
          'precipitation_probability',
          'precipitation',
          'temperature_2m',
          'relative_humidity_2m',
          'wind_speed_10m',
          'weather_code',
        ].join(','),
        timezone: 'Asia/Bangkok',
        forecast_days: 2,
      },
      timeout: 20000,
    }
  );

  return response.data;
}

function findRainInNextTwoHours(data) {
  if (!data.hourly || !Array.isArray(data.hourly.time)) {
    return null;
  }

  const now = Date.now();

  for (let index = 0; index < data.hourly.time.length; index++) {
    const forecastTime = new Date(
      data.hourly.time[index]
    );

    const hoursAhead =
      (forecastTime.getTime() - now) /
      (1000 * 60 * 60);

    if (hoursAhead < 0.75 || hoursAhead > 2.25) {
      continue;
    }

    const probability = Number(
      data.hourly.precipitation_probability[index] || 0
    );

    const amount = Number(
      data.hourly.precipitation[index] || 0
    );

    const weatherCode = Number(
      data.hourly.weather_code[index] || 0
    );

    const rainCode =
      weatherCode >= 51 && weatherCode <= 99;

    if (
      probability >= RAIN_THRESHOLD ||
      amount >= 0.1 ||
      rainCode
    ) {
      return {
        time: forecastTime,
        probability,
        amount,
        temperature: Number(
          data.hourly.temperature_2m[index] || 0
        ),
        humidity: Number(
          data.hourly.relative_humidity_2m[index] || 0
        ),
        wind: Number(
          data.hourly.wind_speed_10m[index] || 0
        ),
      };
    }
  }

  return null;
}

function buildRainMessage(garden, rain) {
  const advice =
    rain.probability >= 80
      ? [
          '• เช็กทางระบายน้ำให้โล่ง',
          '• งดใส่ปุ๋ยและพ่นยา',
          '• ตรวจเชือกพยุงกิ่งและผล',
        ]
      : [
          '• เก็บอุปกรณ์ที่ไม่ควรเปียก',
          '• วางแผนงานให้เสร็จก่อนฝนมา',
          '• เตรียมทางระบายน้ำไว้ก่อน',
        ];

  return [
    '🌿 Durian Rain Alert',
    '',
    `📍 ${garden.name}`,
    '',
    '🌧️ มีแนวโน้มฝนตกในอีก 1–2 ชั่วโมง',
    `🕒 คาดว่าประมาณ ${thaiTime(rain.time)} น.`,
    '',
    `☔ โอกาสฝน ${rain.probability}%`,
    `💧 ปริมาณฝน ${rain.amount.toFixed(1)} มม.`,
    `🌡️ อุณหภูมิ ${Math.round(rain.temperature)}°C`,
    `💦 ความชื้น ${Math.round(rain.humidity)}%`,
    `🍃 ลม ${Math.round(rain.wind)} กม./ชม.`,
    '',
    '🧺 แนะนำให้เตรียมตัว',
    ...advice,
    '',
    'ดูแลสวนและเดินทางปลอดภัยนะคะ 🌱',
  ].join('\n');
}

async function checkRain() {
  console.log('');
  console.log('Checking rain forecast...');

  if (gardens.length === 0) {
    console.log('No gardens found in GARDENS_JSON');

    return {
      checked: 0,
      sent: 0,
      message: 'No gardens configured',
    };
  }

  let sentCount = 0;

  for (const garden of gardens) {
    try {
      const data = await getForecast(garden);
      const rain = findRainInNextTwoHours(data);

      if (!rain) {
        console.log(
          `${garden.name}: no rain in next 1-2 hours`
        );
        continue;
      }

      const alertKey =
        `${garden.id || garden.name}_${rain.time.toISOString()}`;

      if (sentAlerts.has(alertKey)) {
        console.log(
          `${garden.name}: alert already sent`
        );
        continue;
      }

      await sendLine(
        buildRainMessage(garden, rain)
      );

      sentAlerts.set(alertKey, Date.now());
      sentCount++;

      console.log(
        `${garden.name}: LINE alert sent`
      );
    } catch (error) {
      console.error(
        `${garden.name}:`,
        error.response?.data || error.message
      );
    }
  }

  return {
    checked: gardens.length,
    sent: sentCount,
    message: 'Rain forecast checked',
  };
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    server: 'Durian Auto Rain Alert',
    gardenCount: gardens.length,
    rainThreshold: RAIN_THRESHOLD,
    routes: [
      'POST /send-test-line',
      'POST /check-rain-now',
    ],
  });
});

app.post('/send-test-line', async (req, res) => {
  try {
    await sendLine(
      [
        '🌿 Durian Rain Alert',
        '',
        '✅ เชื่อมต่อ LINE สำเร็จ',
        'ระบบพร้อมแจ้งเตือนฝนล่วงหน้าแล้ว',
        '',
        'เดี๋ยวเราช่วยเฝ้าดูอากาศให้นะคะ ☁️',
      ].join('\n')
    );

    res.json({
      success: true,
      message: 'LINE test sent',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error.response?.data || error.message,
    });
  }
});

app.post('/check-rain-now', async (req, res) => {
  try {
    const result = await checkRain();

    res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error.response?.data || error.message,
    });
  }
});

// ตรวจทุก 15 นาที
cron.schedule(
  '*/15 * * * *',
  async () => {
    await checkRain();
  },
  {
    timezone: 'Asia/Bangkok',
  }
);

app.listen(PORT, async () => {
  console.log('');
  console.log('=================================');
  console.log('AUTO RAIN ALERT SERVER IS RUNNING');
  console.log(`http://localhost:${PORT}`);
  console.log(`Gardens: ${gardens.length}`);
  console.log(`Rain threshold: ${RAIN_THRESHOLD}%`);
  console.log('POST /check-rain-now');
  console.log('=================================');
  console.log('');

  await checkRain();
});
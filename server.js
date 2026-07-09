const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');

require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const LINE_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN;

const LINE_USER_ID =
  process.env.LINE_USER_ID;

const RAIN_THRESHOLD = Number(
  process.env.RAIN_PROBABILITY_THRESHOLD || 60
);

let gardens = [];

try {
  gardens = JSON.parse(
    process.env.GARDENS_JSON || '[]'
  );
} catch (error) {
  console.error(
    'GARDENS_JSON ไม่ถูกต้อง:',
    error.message
  );

  gardens = [];
}

// ป้องกันส่งแจ้งเตือนอัตโนมัติซ้ำ
const sentAlerts = new Map();

async function sendLineMessage(text) {
  if (
    !LINE_TOKEN ||
    LINE_TOKEN === 'PUT_TOKEN_HERE'
  ) {
    throw new Error(
      'LINE_CHANNEL_ACCESS_TOKEN is not set'
    );
  }

  if (
    !LINE_USER_ID ||
    !LINE_USER_ID.startsWith('U')
  ) {
    throw new Error(
      'LINE_USER_ID is not set correctly'
    );
  }

  await axios.post(
    'https://api.line.me/v2/bot/message/push',
    {
      to: LINE_USER_ID,
      messages: [
        {
          type: 'text',
          text,
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

function formatThaiTime(date) {
  return new Intl.DateTimeFormat(
    'th-TH',
    {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }
  ).format(date);
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

        timezone: 'UTC',
        timeformat: 'unixtime',
        forecast_days: 2,
      },

      timeout: 20000,
    }
  );

  return response.data;
}

function findRainInNextTwoHours(data) {
  if (
    !data.hourly ||
    !Array.isArray(data.hourly.time)
  ) {
    return null;
  }

  const now = Date.now();

  for (
    let index = 0;
    index < data.hourly.time.length;
    index++
  ) {
    const forecastTime = new Date(
      Number(data.hourly.time[index]) * 1000
    );

    const hoursAhead =
      (forecastTime.getTime() - now) /
      (1000 * 60 * 60);

    if (
      hoursAhead < 0.75 ||
      hoursAhead > 2.25
    ) {
      continue;
    }

    const probability = Number(
      data.hourly
        .precipitation_probability[index] || 0
    );

    const amount = Number(
      data.hourly.precipitation[index] || 0
    );

    const weatherCode = Number(
      data.hourly.weather_code[index] || 0
    );

    const rainWeatherCode =
      weatherCode >= 51 &&
      weatherCode <= 99;

    if (
      probability >= RAIN_THRESHOLD ||
      amount >= 0.1 ||
      rainWeatherCode
    ) {
      return {
        time: forecastTime,
        probability,
        amount,

        temperature: Number(
          data.hourly.temperature_2m[index] || 0
        ),

        humidity: Number(
          data.hourly
            .relative_humidity_2m[index] || 0
        ),

        wind: Number(
          data.hourly.wind_speed_10m[index] || 0
        ),
      };
    }
  }

  return null;
}

function buildRainMessage(
  garden,
  rain
) {
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
    `🕒 คาดว่าประมาณ ${formatThaiTime(
      rain.time
    )} น.`,
    '',
    `☔ โอกาสฝน ${rain.probability}%`,
    `💧 ปริมาณฝน ${rain.amount.toFixed(
      1
    )} มม.`,
    `🌡️ อุณหภูมิ ${Math.round(
      rain.temperature
    )}°C`,
    `💦 ความชื้น ${Math.round(
      rain.humidity
    )}%`,
    `🍃 ลม ${Math.round(
      rain.wind
    )} กม./ชม.`,
    '',
    '🧺 แนะนำให้เตรียมตัว',
    ...advice,
    '',
    'ดูแลสวนและเดินทางปลอดภัยนะคะ 🌱',
  ].join('\n');
}

function buildManualAlertMessage(body) {
  const {
    garden,
    title,
    description,
    advice,
    temperature,
    humidity,
    rain,
    wind,
  } = body;

  return [
    '🌿 Durian Climate Alert',
    '',
    `📍 ${garden}`,
    '',
    `⚠️ ${title}`,
    '',
    description
      ? `รายละเอียด\n${description}`
      : null,
    '',
    temperature
      ? `🌡️ อุณหภูมิ ${temperature}`
      : null,
    humidity
      ? `💧 ความชื้น ${humidity}`
      : null,
    rain
      ? `☔ โอกาสฝน ${rain}`
      : null,
    wind
      ? `🍃 ความเร็วลม ${wind}`
      : null,
    '',
    advice
      ? `💡 คำแนะนำ\n${advice}`
      : null,
    '',
    'ดูแลสวนด้วยนะคะ 🌱',
  ]
    .filter(
      (item) =>
        item !== null &&
        item !== undefined
    )
    .join('\n');
}

async function checkRain() {
  console.log('');
  console.log('Checking rain forecast...');

  if (gardens.length === 0) {
    console.log(
      'No gardens found in GARDENS_JSON'
    );

    return {
      checked: 0,
      sent: 0,
      message: 'No gardens configured',
    };
  }

  let sentCount = 0;

  for (const garden of gardens) {
    try {
      const forecast =
        await getForecast(garden);

      const rain =
        findRainInNextTwoHours(forecast);

      if (!rain) {
        console.log(
          `${garden.name}: no rain in next 1-2 hours`
        );

        continue;
      }

      const alertKey = [
        garden.id || garden.name,
        rain.time.toISOString(),
      ].join('_');

      if (sentAlerts.has(alertKey)) {
        console.log(
          `${garden.name}: alert already sent`
        );

        continue;
      }

      await sendLineMessage(
        buildRainMessage(garden, rain)
      );

      sentAlerts.set(
        alertKey,
        Date.now()
      );

      sentCount++;

      console.log(
        `${garden.name}: LINE alert sent`
      );
    } catch (error) {
      console.error(
        `${garden.name}:`,
        error.response?.data ||
          error.message
      );
    }
  }

  return {
    checked: gardens.length,
    sent: sentCount,
    message: 'Rain forecast checked',
  };
}

// ดูสถานะ Server
app.get('/', (req, res) => {
  res.json({
    success: true,
    server: 'Durian Auto Rain Alert',
    gardenCount: gardens.length,
    rainThreshold: RAIN_THRESHOLD,

    routes: [
      'POST /send-test-line',
      'POST /send-line-alert',
      'POST /check-rain-now',
    ],
  });
});

// ทดสอบ LINE
app.post(
  '/send-test-line',
  async (req, res) => {
    try {
      await sendLineMessage(
        [
          '🌿 Durian Rain Alert',
          '',
          '✅ เชื่อมต่อ LINE สำเร็จ',
          'ระบบแจ้งเตือนพร้อมทำงานแล้ว',
          '',
          'เดี๋ยวเราช่วยเฝ้าดูอากาศให้นะคะ ☁️',
        ].join('\n')
      );

      res.json({
        success: true,
        message: 'LINE test sent',
      });
    } catch (error) {
      console.error(
        error.response?.data ||
          error.message
      );

      res
        .status(
          error.response?.status || 500
        )
        .json({
          success: false,
          message:
            'ส่งข้อความทดสอบไม่สำเร็จ',

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);

// ส่งรายการจากหน้าแอป
app.post(
  '/send-line-alert',
  async (req, res) => {
    try {
      const {
        garden,
        title,
      } = req.body;

      if (!garden || !title) {
        return res.status(400).json({
          success: false,
          message:
            'กรุณาระบุชื่อสวนและหัวข้อแจ้งเตือน',
        });
      }

      const message =
        buildManualAlertMessage(
          req.body
        );

      await sendLineMessage(message);

      res.json({
        success: true,
        message:
          'ส่งแจ้งเตือนเข้า LINE สำเร็จ',
      });
    } catch (error) {
      console.error(
        error.response?.data ||
          error.message
      );

      res
        .status(
          error.response?.status || 500
        )
        .json({
          success: false,
          message:
            'ส่งแจ้งเตือนเข้า LINE ไม่สำเร็จ',

          error:
            error.response?.data ||
            error.message,
        });
    }
  }
);

// สั่งตรวจฝนทันที
app.post(
  '/check-rain-now',
  async (req, res) => {
    try {
      const result =
        await checkRain();

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,

        error:
          error.response?.data ||
          error.message,
      });
    }
  }
);

// เช็กฝนทุก 15 นาที
cron.schedule(
  '*/15 * * * *',
  async () => {
    await checkRain();
  },
  {
    timezone: 'Asia/Bangkok',
  }
);

app.listen(
  PORT,
  async () => {
    console.log('');
    console.log(
      '================================='
    );
    console.log(
      'AUTO RAIN ALERT SERVER IS RUNNING'
    );
    console.log(
      `http://localhost:${PORT}`
    );
    console.log(
      `Gardens: ${gardens.length}`
    );
    console.log(
      `Rain threshold: ${RAIN_THRESHOLD}%`
    );
    console.log(
      'POST /send-test-line'
    );
    console.log(
      'POST /send-line-alert'
    );
    console.log(
      'POST /check-rain-now'
    );
    console.log(
      '================================='
    );
    console.log('');

    await checkRain();
  }
);

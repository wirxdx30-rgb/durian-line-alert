const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs/promises');
const path = require('path');

require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

const LINE_TOKEN =
  process.env.LINE_CHANNEL_ACCESS_TOKEN || '';

const LINE_USER_ID =
  process.env.LINE_USER_ID || '';

const SYNC_API_KEY =
  process.env.SYNC_API_KEY || '';

const DATA_DIR =
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(__dirname, 'data');

const STATE_FILE = path.join(
  DATA_DIR,
  'alert-state.json',
);

// แจ้งเฉพาะอากาศรุนแรง
const SEVERE_WIND_SPEED = 40;
const SEVERE_WIND_GUST = 60;
const SEVERE_RAIN_AMOUNT = 15;
const SEVERE_RAIN_PROBABILITY = 80;

// ตรวจอากาศล่วงหน้า 6 ชั่วโมง
const FORECAST_HOURS_AHEAD = 6;

let weatherCheckInProgress = false;

let state = {
  gardens: [],
  lastAutomaticAlertDate: '',
};

function normalizeGardens(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  const usedIds = new Set();

  return items
    .map((item, index) => {
      const latitude = Number(
        item.latitude,
      );

      const longitude = Number(
        item.longitude,
      );

      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude)
      ) {
        return null;
      }

      if (
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        return null;
      }

      let id = String(
        item.id ||
          `garden_${Date.now()}_${index}`,
      ).trim();

      if (!id) {
        id =
          `garden_${Date.now()}_${index}`;
      }

      if (usedIds.has(id)) {
        id = `${id}_${index}`;
      }

      usedIds.add(id);

      const name = String(
        item.name ||
          `สวนลำดับที่ ${index + 1}`,
      ).trim();

      const address = String(
        item.address ||
          item.location ||
          '',
      ).trim();

      return {
        id,
        name,
        address,
        latitude,
        longitude,
      };
    })
    .filter(Boolean);
}

function parseInitialGardens() {
  try {
    const parsed = JSON.parse(
      process.env.GARDENS_JSON || '[]',
    );

    return normalizeGardens(parsed);
  } catch (error) {
    console.error(
      'GARDENS_JSON ไม่ถูกต้อง:',
      error.message,
    );

    return [];
  }
}

async function saveState() {
  await fs.mkdir(DATA_DIR, {
    recursive: true,
  });

  const temporaryFile =
    `${STATE_FILE}.tmp`;

  const content = JSON.stringify(
    state,
    null,
    2,
  );

  await fs.writeFile(
    temporaryFile,
    content,
    'utf8',
  );

  await fs.rename(
    temporaryFile,
    STATE_FILE,
  );
}

async function loadState() {
  try {
    await fs.mkdir(DATA_DIR, {
      recursive: true,
    });

    const content = await fs.readFile(
      STATE_FILE,
      'utf8',
    );

    const savedState =
      JSON.parse(content);

    state = {
      gardens: normalizeGardens(
        savedState.gardens,
      ),
      lastAutomaticAlertDate:
        typeof savedState
          .lastAutomaticAlertDate ===
        'string'
          ? savedState
              .lastAutomaticAlertDate
          : '',
    };

    console.log(
      `โหลดข้อมูลเดิม ${state.gardens.length} สวน`,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(
        'อ่านไฟล์สถานะไม่สำเร็จ:',
        error.message,
      );
    }

    state = {
      gardens: parseInitialGardens(),
      lastAutomaticAlertDate: '',
    };

    await saveState();

    console.log(
      `สร้างไฟล์สถานะใหม่ ${state.gardens.length} สวน`,
    );
  }
}

async function reloadState() {
  try {
    const content = await fs.readFile(
      STATE_FILE,
      'utf8',
    );

    const savedState =
      JSON.parse(content);

    state = {
      gardens: normalizeGardens(
        savedState.gardens,
      ),
      lastAutomaticAlertDate:
        typeof savedState
          .lastAutomaticAlertDate ===
        'string'
          ? savedState
              .lastAutomaticAlertDate
          : '',
    };
  } catch (_) {
    // ถ้าอ่านไม่ได้ ให้ใช้ค่าในหน่วยความจำ
  }
}

function verifySyncKey(
  req,
  res,
  next,
) {
  if (!SYNC_API_KEY) {
    return next();
  }

  const receivedKey =
    req.headers['x-sync-key'];

  if (receivedKey !== SYNC_API_KEY) {
    return res.status(401).json({
      success: false,
      message:
        'ไม่มีสิทธิ์ซิงก์ข้อมูลสวน',
    });
  }

  next();
}

async function sendLineMessage(text) {
  if (!LINE_TOKEN) {
    throw new Error(
      'ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN',
    );
  }

  if (
    !LINE_USER_ID ||
    !LINE_USER_ID.startsWith('U')
  ) {
    throw new Error(
      'LINE_USER_ID ไม่ถูกต้อง',
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
        Authorization:
          `Bearer ${LINE_TOKEN}`,
        'Content-Type':
          'application/json',
      },
      timeout: 20000,
    },
  );
}

function getThailandDateKey(
  date = new Date(),
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-US',
      {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      },
    ).formatToParts(date);

  const year =
    parts.find(
      (item) => item.type === 'year',
    )?.value;

  const month =
    parts.find(
      (item) => item.type === 'month',
    )?.value;

  const day =
    parts.find(
      (item) => item.type === 'day',
    )?.value;

  return `${year}-${month}-${day}`;
}

function formatThaiDate(date) {
  return new Intl.DateTimeFormat(
    'th-TH',
    {
      timeZone: 'Asia/Bangkok',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    },
  ).format(date);
}

function formatThaiTime(date) {
  return new Intl.DateTimeFormat(
    'th-TH',
    {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    },
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
          'rain',
          'showers',
          'wind_speed_10m',
          'wind_gusts_10m',
          'weather_code',
        ].join(','),

        timezone: 'Asia/Bangkok',
        forecast_days: 2,
      },

      timeout: 20000,
    },
  );

  return response.data;
}

function numberAt(
  hourly,
  field,
  index,
) {
  return Number(
    hourly?.[field]?.[index] ?? 0,
  );
}

function findSevereWeather(data) {
  const hourly = data?.hourly;

  if (
    !hourly ||
    !Array.isArray(hourly.time)
  ) {
    return null;
  }

  const now = Date.now();
  const severeEvents = [];

  for (
    let index = 0;
    index < hourly.time.length;
    index++
  ) {
    const forecastTime = new Date(
      hourly.time[index],
    );

    if (
      Number.isNaN(
        forecastTime.getTime(),
      )
    ) {
      continue;
    }

    const hoursAhead =
      (
        forecastTime.getTime() -
        now
      ) /
      3600000;

    if (
      hoursAhead < 0 ||
      hoursAhead >
        FORECAST_HOURS_AHEAD
    ) {
      continue;
    }

    const weatherCode = numberAt(
      hourly,
      'weather_code',
      index,
    );

    const windSpeed = numberAt(
      hourly,
      'wind_speed_10m',
      index,
    );

    const windGust = numberAt(
      hourly,
      'wind_gusts_10m',
      index,
    );

    const rainProbability = numberAt(
      hourly,
      'precipitation_probability',
      index,
    );

    const precipitation = numberAt(
      hourly,
      'precipitation',
      index,
    );

    const rain = numberAt(
      hourly,
      'rain',
      index,
    );

    const showers = numberAt(
      hourly,
      'showers',
      index,
    );

    const rainAmount = Math.max(
      precipitation,
      rain,
      showers,
    );

    const isThunderstorm =
      weatherCode >= 95 &&
      weatherCode <= 99;

    const isSevereWind =
      windSpeed >=
      SEVERE_WIND_SPEED;

    const isSevereGust =
      windGust >=
      SEVERE_WIND_GUST;

    const isHeavyRain =
      rainAmount >=
        SEVERE_RAIN_AMOUNT &&
      rainProbability >=
        SEVERE_RAIN_PROBABILITY;

    if (
      !isThunderstorm &&
      !isSevereWind &&
      !isSevereGust &&
      !isHeavyRain
    ) {
      continue;
    }

    let type =
      'สภาพอากาศรุนแรง';

    let icon = '🚨';

    if (isThunderstorm) {
      type = 'พายุฝนฟ้าคะนอง';
      icon = '⛈️';
    } else if (
      isSevereWind ||
      isSevereGust
    ) {
      type = 'ลมแรงจัด';
      icon = '💨';
    } else if (isHeavyRain) {
      type = 'ฝนตกหนักจัด';
      icon = '🌧️';
    }

    let score = 0;

    if (isThunderstorm) {
      score += 1000;
    }

    score += windGust * 3;
    score += windSpeed * 2;
    score += rainAmount * 10;
    score += rainProbability;

    severeEvents.push({
      time: forecastTime,
      type,
      icon,
      weatherCode,
      windSpeed,
      windGust,
      rainProbability,
      rainAmount,
      isThunderstorm,
      isSevereWind,
      isSevereGust,
      isHeavyRain,
      score,
    });
  }

  if (severeEvents.length === 0) {
    return null;
  }

  severeEvents.sort(
    (first, second) =>
      second.score - first.score,
  );

  return severeEvents[0];
}

function buildSevereMessage(
  severeGardens,
) {
  const sections =
    severeGardens.map(
      ({ garden, event }) => {
        const advice = [];

        if (
          event.isThunderstorm ||
          event.isSevereWind ||
          event.isSevereGust
        ) {
          advice.push(
            '• ตรวจเชือกพยุงกิ่งและผลทุเรียน',
          );

          advice.push(
            '• เก็บอุปกรณ์ที่อาจปลิวออกจากสวน',
          );
        }

        if (
          event.isThunderstorm ||
          event.isHeavyRain
        ) {
          advice.push(
            '• ตรวจทางระบายน้ำไม่ให้อุดตัน',
          );

          advice.push(
            '• งดพ่นยาและงดใส่ปุ๋ยชั่วคราว',
          );
        }

        if (advice.length === 0) {
          advice.push(
            '• หลีกเลี่ยงการทำงานกลางแจ้ง',
          );
        }

        return [
          `${event.icon} ${event.type}`,
          `📍 ${garden.name}`,
          garden.address
            ? `🗺️ ${garden.address}`
            : null,
          `🕒 คาดว่าประมาณ ${formatThaiTime(
            event.time,
          )} น.`,
          `🌧️ ฝน ${event.rainAmount.toFixed(
            1,
          )} มม./ชม.`,
          `☔ โอกาสฝน ${Math.round(
            event.rainProbability,
          )}%`,
          `💨 ลม ${Math.round(
            event.windSpeed,
          )} กม./ชม.`,
          `🌪️ ลมกระโชก ${Math.round(
            event.windGust,
          )} กม./ชม.`,
          '',
          '🧺 คำแนะนำ',
          ...advice,
        ]
          .filter(
            (item) => item !== null,
          )
          .join('\n');
      },
    );

  return [
    '🚨 แจ้งเตือนอากาศรุนแรง',
    `📅 ${formatThaiDate(
      new Date(),
    )}`,
    '',
    sections.join(
      '\n\n────────────\n\n',
    ),
    '',
    'ระบบแจ้งอัตโนมัติสูงสุดวันละ 1 ครั้ง',
    'ฝนหรือลมทั่วไปจะไม่แจ้งเตือนค่ะ 🌿',
  ].join('\n');
}

function buildManualMessage(body) {
  const garden =
    body.garden || 'สวนของคุณ';

  const title =
    body.title || 'แจ้งเตือนจากแอป';

  return [
    '🌿 DURIAN CLIMATE ALERT',
    '',
    `📍 ${garden}`,
    `⚠️ ${title}`,
    body.description
      ? `\n📝 ${body.description}`
      : '',
    body.temperature
      ? `\n🌡️ อุณหภูมิ ${body.temperature}`
      : '',
    body.humidity
      ? `\n💧 ความชื้น ${body.humidity}`
      : '',
    body.rain
      ? `\n☔ โอกาสฝน ${body.rain}`
      : '',
    body.wind
      ? `\n💨 ความเร็วลม ${body.wind}`
      : '',
    body.advice
      ? `\n\n🧺 คำแนะนำ\n${body.advice}`
      : '',
  ].join('\n');
}

async function checkSevereWeather() {
  if (weatherCheckInProgress) {
    return {
      checked: 0,
      sent: 0,
      message:
        'ระบบกำลังตรวจอากาศอยู่',
    };
  }

  weatherCheckInProgress = true;

  try {
    await reloadState();

    const todayKey =
      getThailandDateKey();

    if (
      state.lastAutomaticAlertDate ===
      todayKey
    ) {
      return {
        checked:
          state.gardens.length,
        sent: 0,
        alreadySentToday: true,
        message:
          'วันนี้ส่งแจ้งเตือนแล้ว',
      };
    }

    if (state.gardens.length === 0) {
      return {
        checked: 0,
        sent: 0,
        alreadySentToday: false,
        message:
          'ยังไม่มีสวนในระบบ',
      };
    }

    const severeGardens = [];

    for (
      const garden of state.gardens
    ) {
      try {
        const forecast =
          await getForecast(garden);

        const severeEvent =
          findSevereWeather(
            forecast,
          );

        if (severeEvent) {
          severeGardens.push({
            garden,
            event: severeEvent,
          });

          console.log(
            `${garden.name}: พบอากาศรุนแรง`,
          );
        } else {
          console.log(
            `${garden.name}: อากาศไม่รุนแรง`,
          );
        }
      } catch (error) {
        console.error(
          `ตรวจสวน ${garden.name} ไม่สำเร็จ:`,
          error.response?.data ||
            error.message,
        );
      }
    }

    if (severeGardens.length === 0) {
      return {
        checked:
          state.gardens.length,
        sent: 0,
        alreadySentToday: false,
        severeGardenCount: 0,
        message:
          'ไม่พบอากาศรุนแรง',
      };
    }

    await reloadState();

    if (
      state.lastAutomaticAlertDate ===
      todayKey
    ) {
      return {
        checked:
          state.gardens.length,
        sent: 0,
        alreadySentToday: true,
        message:
          'มีคำสั่งอื่นส่งวันนี้ไปแล้ว',
      };
    }

    await sendLineMessage(
      buildSevereMessage(
        severeGardens,
      ),
    );

    state.lastAutomaticAlertDate =
      todayKey;

    await saveState();

    return {
      checked:
        state.gardens.length,
      sent: 1,
      alreadySentToday: false,
      severeGardenCount:
        severeGardens.length,
      message:
        'ส่งแจ้งเตือนอากาศรุนแรงแล้ว',
    };
  } finally {
    weatherCheckInProgress = false;
  }
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    service:
      'Durian Climate Alert',

    gardenCount:
      state.gardens.length,

    gardens:
      state.gardens.map(
        (garden) => ({
          id: garden.id,
          name: garden.name,
          address: garden.address,
          latitude:
            garden.latitude,
          longitude:
            garden.longitude,
        }),
      ),

    automaticAlert:
      'สูงสุดวันละ 1 ครั้ง',

    forecastHoursAhead:
      FORECAST_HOURS_AHEAD,

    lastAutomaticAlertDate:
      state.lastAutomaticAlertDate ||
      null,

    severeThresholds: {
      windSpeed:
        `${SEVERE_WIND_SPEED} km/h`,
      windGust:
        `${SEVERE_WIND_GUST} km/h`,
      heavyRain:
        `${SEVERE_RAIN_AMOUNT} mm/h`,
      rainProbability:
        `${SEVERE_RAIN_PROBABILITY}%`,
      thunderstormCode:
        '95-99',
    },

    routes: [
      'GET /',
      'GET /gardens',
      'POST /sync-gardens',
      'POST /send-test-line',
      'POST /send-line-alert',
      'POST /check-rain-now',
    ],
  });
});

app.post(
  '/sync-gardens',
  verifySyncKey,
  async (req, res) => {
    try {
      const incomingGardens =
        Array.isArray(req.body)
          ? req.body
          : req.body.gardens;

      if (
        !Array.isArray(
          incomingGardens,
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              'ข้อมูล gardens ต้องเป็นรายการ',
          });
      }

      const normalized =
        normalizeGardens(
          incomingGardens,
        );

      if (
        incomingGardens.length > 0 &&
        normalized.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              'ข้อมูลพิกัดสวนไม่ถูกต้อง',
          });
      }

      state.gardens = normalized;

      await saveState();

      console.log(
        `ซิงก์สวนสำเร็จ ${state.gardens.length} สวน`,
      );

      res.json({
        success: true,
        gardenCount:
          state.gardens.length,
        gardens:
          state.gardens,
        message:
          'ซิงก์รายชื่อสวนสำเร็จ',
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          'บันทึกรายชื่อสวนไม่สำเร็จ',
        error: error.message,
      });
    }
  },
);

app.get(
  '/gardens',
  verifySyncKey,
  (req, res) => {
    res.json({
      success: true,
      gardenCount:
        state.gardens.length,
      gardens:
        state.gardens,
    });
  },
);

app.post(
  '/send-test-line',
  async (req, res) => {
    try {
      await sendLineMessage(
        [
          '🌿 เชื่อมต่อ LINE สำเร็จ',
          '',
          'ระบบตั้งค่าเป็น',
          '• แจ้งเฉพาะพายุฝนฟ้าคะนอง',
          '• แจ้งเฉพาะลมแรงจัด',
          '• แจ้งเฉพาะฝนตกหนักจัด',
          '• แจ้งอัตโนมัติสูงสุดวันละ 1 ครั้ง',
          '',
          'ข้อความนี้เป็นข้อความทดสอบ',
        ].join('\n'),
      );

      res.json({
        success: true,
        message:
          'ส่งข้อความทดสอบสำเร็จ',
      });
    } catch (error) {
      res
        .status(
          error.response?.status ||
            500,
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
  },
);

app.post(
  '/send-line-alert',
  async (req, res) => {
    try {
      await sendLineMessage(
        buildManualMessage(
          req.body || {},
        ),
      );

      res.json({
        success: true,
        message:
          'ส่งข้อความด้วยตนเองสำเร็จ',
      });
    } catch (error) {
      res
        .status(
          error.response?.status ||
            500,
        )
        .json({
          success: false,
          message:
            'ส่งข้อความไม่สำเร็จ',
          error:
            error.response?.data ||
            error.message,
        });
    }
  },
);

app.post(
  '/check-rain-now',
  async (req, res) => {
    try {
      const result =
        await checkSevereWeather();

      res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message:
          'ตรวจสภาพอากาศไม่สำเร็จ',
        error:
          error.response?.data ||
          error.message,
      });
    }
  },
);

// ตรวจทุก 30 นาที
// แต่ส่งแจ้งเตือนสูงสุดวันละ 1 ครั้ง
cron.schedule(
  '*/30 * * * *',
  async () => {
    try {
      const result =
        await checkSevereWeather();

      console.log(
        new Date().toISOString(),
        result.message,
      );
    } catch (error) {
      console.error(
        'Cron error:',
        error.message,
      );
    }
  },
  {
    timezone: 'Asia/Bangkok',
  },
);

async function startServer() {
  await loadState();

  app.listen(PORT, () => {
    console.log('');
    console.log(
      '================================',
    );
    console.log(
      'DURIAN ALERT SERVER RUNNING',
    );
    console.log(
      `PORT: ${PORT}`,
    );
    console.log(
      `GARDENS: ${state.gardens.length}`,
    );
    console.log(
      `DATA FILE: ${STATE_FILE}`,
    );
    console.log(
      'AUTO ALERT: MAX 1 PER DAY',
    );
    console.log(
      '================================',
    );
    console.log('');
  });

  // ไม่ตรวจทันทีตอนเปิดเซิร์ฟเวอร์
  // ป้องกัน Deploy แล้วแจ้งซ้ำ
}

startServer().catch(
  (error) => {
    console.error(
      'เปิด Server ไม่สำเร็จ:',
      error,
    );

    process.exit(1);
  },
);

# Durian LINE Alert Backend v2

ไฟล์ชุดนี้รองรับ:

- `POST /line/webhook`
- `POST /line/link-code`
- `GET /line/status?phone=...`
- `POST /line/test`
- `POST /line/disconnect`
- `/sync-gardens` และ `/gardens` สำหรับ Flutter รุ่นเดิม
- เก็บข้อมูลถาวรใน `/data/alert-state.json`

## Railway Variables

ต้องมี:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `DATA_DIR=/data`
- `SYNC_API_KEY=durian_garden_sync_2026`
- `LINE_OA_ID=@943krgpw`

`LINE_USER_ID` เก็บไว้ได้ชั่วคราวเพื่อรองรับปุ่มทดสอบแบบเดิม

## Webhook URL

หลัง Deploy:

`https://durian-line-alert-production.up.railway.app/line/webhook`

นำ URL ไปใส่ใน LINE Official Account Manager แล้วกด Verify และเปิด Use webhook.

# GHosting Daemon

โปรแกรมเอเจนต์ฝั่งเครื่องโหนดสำหรับ GHosting ทำหน้าที่จัดการ Docker containers, เก็บข้อมูลสถิติ (Metrics), ดึงข้อมูล Log จากคอนโซล, และจัดการระบบไฟล์/แบ็คอัพบนเครื่องแมชชีน

## ฟีเจอร์หลัก (Features)

- **การจัดการ Docker** — สร้าง, เริ่มทำงาน, หยุด, รีสตาร์ท, ปิดบังคับ (Kill), และลบเซิร์ฟเวอร์เกม (Container)
- **ตรวจสอบทรัพยากร (System Metrics)** — ดึงข้อมูลการใช้ CPU, RAM, ดิสก์, และเครือข่าย แบบละเอียด
- **คอนโซลแบบเรียลไทม์ (Console)** — สตรีม Log ของคอนเทนเนอร์สดๆ ผ่าน Server-Sent Events (SSE)
- **ตัวจัดการไฟล์ (File Manager)** — ดูรายชื่อไฟล์, อ่าน, เขียน, อัพโหลด, ดาวน์โหลด, สร้าง, และลบไฟล์ภายในเครื่องเซิร์ฟเวอร์ได้
- **แบ็คอัพและกู้คืน (Backup & Restore)** — สร้างไฟล์แบ็คอัพ `.tar.gz` ได้อย่างรวดเร็วและปลอดภัย
- **TCP Proxy** — ส่งต่อการเชื่อมต่อให้ผู้เล่นเข้าห้องเกมได้ โดยไม่ต้องต่อกับ Docker Port ตรงๆ
- **FRP Tunneling** — รองรับ Fast Reverse Proxy (FRP) เพื่อทะลวงผ่านเร้าเตอร์สำหรับเครื่องที่ไม่ได้ Public IP
- **Stateless HTTP API** — ใช้สถาปัตยกรรม REST API 100% ทำให้ติดตั้งง่ายและเบาเครื่อง ไร้การเชื่อมต่อค้าง (WebSocket)

## เริ่มต้นใช้งาน (Quick Start)

### สิ่งที่ต้องเตรียม (Prerequisites)

- Node.js 20+
- ติดตั้งและรัน Docker Engine เอาไว้แล้ว
- มีสิทธิ์ในการเข้าถึง Docker socket (`/var/run/docker.sock`)

### รันผ่าน Docker

```bash
# รันจากโฟลเดอร์ daemon ได้เลยครับ
cd daemon
docker compose up -d
```

### รันบนเครื่องจริง (สำหรับการพัฒนา)

```bash
# ติดตั้งแพ็คเกจ
npm install

# คัดลอกและตั้งค่า Environment เบื้องต้น
cp .env.example .env
# แก้ไขไฟล์ .env เพื่อใส่ข้อมูลที่ต้องการ

# รันพร้อมระบบ Auto-reload เพื่อสะดวกในการแก้ไขโค้ด
npm run dev
```

## ตัวแปรสภาพแวดล้อม (Environment Variables)

กำหนดค่าที่ไฟล์ `.env` :

| ตัวแปร | ค่าเริ่มต้น (Default) | คำอธิบาย |
|---|---|---|
| `DAEMON_ID` | `daemon-01` | รหัสประจำตัวของ Daemon (ห้ามซ้ำกันหากมีหลายโหนด) |
| `NODE_NAME` | `SG-1` | ชื่อโหนดสำหรับแสดงผลหน้าเว็บ |
| `DAEMON_AUTH_TOKEN` | `ghd_dev_token` | โทเคนสำหรับยืนยันความปลอดภัย (ต้องตั้งค่าให้ตรงกับหน้าเว็บ GHosting) |
| `DAEMON_PORT` | `8443` | พอร์ตที่ Daemon จะเปิดรอรับคำสั่ง (REST API) |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | พาธที่อยู่ของ Docker socket บนเครื่องโหนด |
| `DATA_DIR` | `/opt/ghosting/data` | โฟลเดอร์ที่ใช้เก็บข้อมูลเซิร์ฟเวอร์เกม และไฟล์แบ็คอัพ |
| `CONTAINER_PREFIX` | `gs-` | คำนำหน้าชื่อของ Docker container เมื่อถูกสร้าง |
| `FRP_ENABLED` | `false` | ตั้งค่า เปิด-ปิด ระบบ FRP |

## API Endpoints (เส้นทางการสื่อสาร)

รับคำสั่งแบบไร้สถานะ (Stateless Protocol):

| วิธีการ (Method) | เส้นทาง (Path) | คำอธิบาย |
|---|---|---|
| `GET` | `/api/health` | ดูข้อมูลแจ้งสถานะแบนด์วิธ และสเป็คเครื่องโหนด |
| `GET` | `/api/servers` | แสดงรายการคอนเทนเนอร์ที่ GHosting จัดการรันอยู่ |
| `POST` | `/api/servers` | สร้างเซิร์ฟเวอร์เกมห้องใหม่ลงโหนด |
| `DELETE` | `/api/servers/:id` | ลบเซิร์ฟเวอร์ |
| `POST` | `/api/servers/:id/power` | ควบคุมปุ่มเปิดห้อง พลังงานต่างๆ (start/stop/restart/kill) |
| `GET` | `/api/servers/:id/stats` | นำข้อมูลการใช้ทรัพยากรเกมนั้นๆ ออกมา (Dashboard) |
| `GET` | `/api/servers/:id/console/stream` | สตรีมหน้าปัด Console สีดำๆ (เชื่อมต่อรูปแบบ SSE) |
| `POST` | `/api/servers/:id/console/input` | รับคำสั่งให้ทำงานหน้าปัด Console ผ่าน stdin |
| `GET` | `/api/servers/:id/files` | เรียกลายละเอียดไฟล์โฟลเดอร์ |
| `GET` | `/api/servers/:id/files/content` | อ่านเนื้อหาไฟล์เซิร์ฟเวอร์ |
| `PUT` | `/api/servers/:id/files/content` | การแก้ไจเนื้อหาไฟล์เซิร์ฟเวอร์ |
| `POST` | `/api/servers/:id/files/upload` | อัพโหลดไฟล์เข้า |
| `GET` | `/api/servers/:id/files/download` | ดาวน์โหลดไฟล์ออก |
| `GET` | `/api/servers/:id/backups` | ดึงระบบค้นหาประวัติแบ็คอัพที่มี |
| `POST` | `/api/servers/:id/backups` | สร้างแบ็คอัพ |
| `DELETE` | `/api/servers/:id/backups/:file` | สั่งลบแบ็คอัพ |
| `POST` | `/api/servers/:id/backups/:file/restore` | เริ่มระบบ Restore แบ็คอัพ |
| `GET` | `/api/metrics` | ดู Metrics ของแผงเซิร์ฟเวอร์ |

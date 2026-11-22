# Veyzo

Asenkron video işleme platformu: kırpma, sıkıştırma, GIF, ses ayırma, birleştirme.

## Yapı
- `backend/`: Spring Boot, Java 21, PostgreSQL, FFmpeg
- `frontend/`: React, Vite, Nginx

## Çalıştırma
1. `cp .env.example .env` ve değerleri doldur
2. `docker compose up --build`
3. Arayüz: http://localhost, API: http://localhost:8080

## Geliştirme (Docker'sız)
- Backend: `cd backend && ./mvnw spring-boot:run`
- Frontend: `cd frontend && npm install && npm run dev`
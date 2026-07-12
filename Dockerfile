# Zero npm dependencies, so the image only needs Node itself — no `npm install` layer.
FROM node:22-alpine

WORKDIR /app
COPY src ./src
COPY package.json .

# SQLite data lives in a volume-friendly directory
RUN mkdir -p /app/data

ENV PORT=4000
EXPOSE 4000

CMD ["node", "src/index.js"]

FROM node:22-alpine
WORKDIR /app
COPY vinted-pro/package.json ./
COPY vinted-pro/server ./server
COPY vinted-pro/public ./public
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server/server.js"]

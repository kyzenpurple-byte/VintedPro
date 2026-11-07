FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV HOST=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
CMD ["node", "server/server.js"]

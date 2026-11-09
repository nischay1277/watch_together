FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.cjs ./
COPY public ./public
ENV PORT=4317 BIND_HOST=0.0.0.0 NODE_ENV=production
EXPOSE 4317
USER node
CMD ["node", "server.cjs"]

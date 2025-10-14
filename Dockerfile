FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# usa npm ci se existir lock; cai pra npm install se não tiver
RUN npm ci --omit=dev || npm install --omit=dev
COPY egress.js ./
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node","egress.js"]

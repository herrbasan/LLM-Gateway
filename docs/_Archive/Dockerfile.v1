FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Bundle app source
COPY . .

# Ensure config.json exists. If it does not, fall back to the example.
RUN if [ ! -f config.json ]; then cp config.example.json config.json; fi

# Expose the default port specified in config.json
EXPOSE 3400

# Start the Node.js application
CMD [ "npm", "start" ]

FROM node:12

WORKDIR /usr/src/app

# Copy NodeCG (just the files we need)
RUN mkdir cfg && mkdir bundles && mkdir logs && mkdir db && mkdir assets
COPY . /usr/src/app/
# RUN ls -la /usr/src/app/cfg

# WORKDIR /usr/src/app/cfg
# COPY ./cfg/nodecg.json /usr/src/app/cfg/
# Install dependencies
RUN npm install --production
RUN npm install short-unique-id --save
RUN npm install gsap --save
RUN npm install sortablejs --save
RUN npm install vuedraggable --save
RUN npm install cors --save
RUN npm install shortid --save
RUN npm install mongoose --save
 
# Install Bundles
# Setting working directory for bundles
WORKDIR /usr/src/app/bundles
# Cloning Report to bundles Folder
RUN git clone https://github.com/KiwiVFX/basic-layout.git /usr/src/app/bundles/basic-layout
# Changing Working Directory back to app

WORKDIR /usr/src/app

# The command to run
# EXPOSE 9090
CMD ["node", "index.js"]
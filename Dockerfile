FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY htpasswd /etc/nginx/.htpasswd
EXPOSE 80

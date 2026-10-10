ARG BUILD_FROM
FROM $BUILD_FROM
RUN apk add --no-cache python3 py3-pip py3-pillow py3-flask \
 && pip install --no-cache-dir --break-system-packages vtracer
COPY app.py /app.py
COPY static /static
COPY run.sh /run.sh
RUN chmod a+x /run.sh
CMD ["/run.sh"]

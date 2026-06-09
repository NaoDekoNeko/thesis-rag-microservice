FROM python:3.12-slim
WORKDIR /indexer
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY document_processor.py .
ENTRYPOINT ["python", "/indexer/document_processor.py"]

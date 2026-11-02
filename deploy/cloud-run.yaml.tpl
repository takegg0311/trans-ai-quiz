# deploy/render-cloud-run.sh で envsubst により生成する。生成物 cloud-run.yaml は Git 管理外。
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${CLOUD_RUN_SERVICE}
  annotations:
    run.googleapis.com/ingress: all
    run.googleapis.com/maxScale: '1'
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/maxScale: '1'
        autoscaling.knative.dev/minScale: '0'
        run.googleapis.com/startup-cpu-boost: 'true'
    spec:
      serviceAccountName: ${RUN_SERVICE_ACCOUNT}
      containerConcurrency: 80
      timeoutSeconds: 3600
      containers:
        - image: ${CONTAINER_IMAGE}
          ports:
            - name: http1
              containerPort: 8080
          resources:
            limits:
              cpu: '1'
              memory: 1Gi
          env:
            - name: GOOGLE_CLOUD_PROJECT
              value: ${GCP_PROJECT}
            - name: QUIZ_PUBLIC_URL
              value: ${QUIZ_PUBLIC_URL}
            - name: QUIZ_BUCKET
              value: ${QUIZ_BUCKET}
            - name: QUIZ_DATABASE
              value: ${QUIZ_DATABASE}
            - name: QUIZ_COLLECTION
              value: ${QUIZ_COLLECTION}
            - name: QUIZ_HOST_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: quiz-host-password
                  key: '1'
            - name: QUIZ_SESSION_SECRET
              valueFrom:
                secretKeyRef:
                  name: quiz-session-secret
                  key: '1'
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: quiz-anthropic-api-key
                  key: '1'
            - name: GEMINI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: quiz-gemini-api-key
                  key: '1'
            - name: XAI_API_KEY
              valueFrom:
                secretKeyRef:
                  name: quiz-xai-api-key
                  key: '1'
            - name: TYPESAFE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: quiz-typesafe-api-key
                  key: '1'
          startupProbe:
            httpGet:
              path: /api/health
              port: 8080
            periodSeconds: 2
            failureThreshold: 30
  traffic:
    - latestRevision: true
      percent: 100

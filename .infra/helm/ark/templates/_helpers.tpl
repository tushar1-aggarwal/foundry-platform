{{/*
Expand the name of the chart.
*/}}
{{- define "ark.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "ark.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "ark.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "ark.labels" -}}
helm.sh/chart: {{ include "ark.chart" . }}
{{ include "ark.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "ark.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ark.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Worker selector labels.
*/}}
{{- define "ark.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "ark.name" . }}-worker
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
PostgreSQL host -- internal service name when bundled, external host otherwise.
*/}}
{{- define "ark.postgresqlHost" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "%s-postgresql" (include "ark.fullname" .) }}
{{- else }}
{{- .Values.postgresql.external.host }}
{{- end }}
{{- end }}

{{/*
PostgreSQL port.
*/}}
{{- define "ark.postgresqlPort" -}}
{{- if .Values.postgresql.enabled }}
{{- "5432" }}
{{- else }}
{{- .Values.postgresql.external.port | toString }}
{{- end }}
{{- end }}

{{/*
DATABASE_URL constructed from postgresql values.
*/}}
{{- define "ark.databaseUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgres://%s:%s@%s:%s/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password (include "ark.postgresqlHost" .) (include "ark.postgresqlPort" .) .Values.postgresql.auth.database }}
{{- end }}
{{- end }}

{{/*
Redis host -- internal service name when bundled, external host otherwise.
*/}}
{{- define "ark.redisHost" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis" (include "ark.fullname" .) }}
{{- else }}
{{- .Values.redis.external.host }}
{{- end }}
{{- end }}

{{/*
Redis port.
*/}}
{{- define "ark.redisPort" -}}
{{- if .Values.redis.enabled }}
{{- "6379" }}
{{- else }}
{{- .Values.redis.external.port | toString }}
{{- end }}
{{- end }}

{{/*
REDIS_URL constructed from redis values.
*/}}
{{- define "ark.redisUrl" -}}
{{- printf "redis://%s:%s" (include "ark.redisHost" .) (include "ark.redisPort" .) }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "ark.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "ark.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
LLM secret name -- user-provided or chart-generated.
*/}}
{{- define "ark.llmSecretName" -}}
{{- if .Values.llm.existingSecret }}
{{- .Values.llm.existingSecret }}
{{- else }}
{{- printf "%s-llm" (include "ark.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Database secret name -- user-provided or chart-generated.
*/}}
{{- define "ark.dbSecretName" -}}
{{- if and (not .Values.postgresql.enabled) .Values.postgresql.external.existingSecret }}
{{- .Values.postgresql.external.existingSecret }}
{{- else }}
{{- printf "%s-db" (include "ark.fullname" .) }}
{{- end }}
{{- end }}

{{/*
LocalStack service name (in-cluster).
*/}}
{{- define "ark.localstackServiceName" -}}
{{- printf "%s-localstack" (include "ark.fullname" .) }}
{{- end }}

{{/*
S3 endpoint -- in-cluster LocalStack service when enabled, external endpoint
when set, empty string otherwise (real AWS S3).
*/}}
{{- define "ark.s3Endpoint" -}}
{{- if .Values.localstack.enabled }}
{{- printf "http://%s:4566" (include "ark.localstackServiceName" .) }}
{{- else if .Values.localstack.external.endpoint }}
{{- .Values.localstack.external.endpoint }}
{{- end }}
{{- end }}

{{/*
Master postgres secret for the temporal-db-bootstrap job. Defaults to the
chart-managed db secret when postgresql.enabled (DB_USERNAME/DB_PASSWORD
written by templates/secret.yaml in that case); else falls back to
postgresql.external.existingSecret (operator-supplied) or the explicit
dbBootstrap.masterSecretName override.
*/}}
{{- define "ark.temporalBootstrapMasterSecret" -}}
{{- if .Values.temporal.dbBootstrap.masterSecretName }}
{{- .Values.temporal.dbBootstrap.masterSecretName }}
{{- else if .Values.postgresql.enabled }}
{{- include "ark.dbSecretName" . }}
{{- else }}
{{- .Values.postgresql.external.existingSecret }}
{{- end }}
{{- end }}

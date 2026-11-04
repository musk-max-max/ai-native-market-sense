{{- define "market-sense.name" -}}
market-sense
{{- end -}}

{{- define "market-sense.fullname" -}}
{{- printf "%s-%s" "market-sense" .Values.global.environment | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "market-sense.labels" -}}
app.kubernetes.io/name: {{ include "market-sense.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: market-sense
market-sense.io/environment: {{ .Values.global.environment }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "market-sense.selectorLabels" -}}
app.kubernetes.io/name: {{ include "market-sense.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "market-sense.image" -}}
{{- if .digest -}}
{{- printf "%s/%s@%s" .registry .repository .digest -}}
{{- else -}}
{{- printf "%s/%s:%s" .registry .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "market-sense.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default "market-sense-app" .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "market-sense.configName" -}}
{{- printf "%s-config" (include "market-sense.fullname" .) -}}
{{- end -}}

{{- define "market-sense.ingressHost" -}}
{{- if eq .Values.global.environment "preview" -}}
{{- printf "pr-%v.preview.market-sense.invalid" .Values.preview.prNumber -}}
{{- else -}}
{{- .Values.ingress.host -}}
{{- end -}}
{{- end -}}

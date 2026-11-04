# market-sense-h5 · Kubernetes 环境模块（dev / preview 共用）
#
# 只负责「环境底座」：namespace、资源配额、LimitRange、ServiceAccount、NetworkPolicy。
# 应用发布走 Helm（infra/helm/market-sense），两者职责分离，便于回滚与重建。
# 生产（S1 以后）复用本模块，但 backend 必须改为远端 state + 锁定（见 envs/dev/README）。
terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "2.33.0"
    }
  }
}

variable "namespace" {
  description = "环境命名空间（dev: market-sense-dev；preview: market-sense-preview-pr-<n>）"
  type        = string
}

variable "environment" {
  description = "环境名：dev | preview | production"
  type        = string
}

variable "pr_number" {
  description = "preview 环境的 PR 号（dev/production 为 0）"
  type        = number
  default     = 0
}

variable "quota_pods" {
  type    = string
  default = "20"
}

variable "quota_requests_cpu" {
  type    = string
  default = "4"
}

variable "quota_requests_memory" {
  type    = string
  default = "8Gi"
}

variable "quota_limits_cpu" {
  type    = string
  default = "8"
}

variable "quota_limits_memory" {
  type    = string
  default = "16Gi"
}

variable "ingress_namespace" {
  description = "允许访问本环境的 ingress controller 所在命名空间"
  type        = string
  default     = "ingress-nginx"
}

locals {
  labels = {
    "app.kubernetes.io/part-of"   = "market-sense"
    "market-sense.io/environment" = var.environment
    "market-sense.io/pr"          = tostring(var.pr_number)
    "market-sense.io/managed-by"  = "terraform"
    "market-sense.io/owner"       = "A13-sre"
  }
}

resource "kubernetes_namespace" "this" {
  metadata {
    name   = var.namespace
    labels = local.labels
    annotations = {
      "market-sense.io/environment"   = var.environment
      "market-sense.io/pr"            = tostring(var.pr_number)
      "market-sense.io/recreate-with" = "terraform apply（禁止 kubectl 手工改）"
    }
  }
}

resource "kubernetes_resource_quota" "this" {
  metadata {
    name      = "market-sense-quota"
    namespace = kubernetes_namespace.this.metadata[0].name
    labels    = local.labels
  }
  spec {
    hard = {
      "pods"                   = var.quota_pods
      "requests.cpu"           = var.quota_requests_cpu
      "requests.memory"        = var.quota_requests_memory
      "limits.cpu"             = var.quota_limits_cpu
      "limits.memory"          = var.quota_limits_memory
      "services"               = "10"
      "loadbalancers"          = "1"
      "persistentvolumeclaims" = "2"
    }
  }
}

resource "kubernetes_limit_range" "this" {
  metadata {
    name      = "market-sense-limits"
    namespace = kubernetes_namespace.this.metadata[0].name
    labels    = local.labels
  }
  spec {
    limit {
      type = "Container"
      default = {
        cpu    = "500m"
        memory = "512Mi"
      }
      default_request = {
        cpu    = "100m"
        memory = "128Mi"
      }
      max = {
        cpu    = "2"
        memory = "2Gi"
      }
    }
  }
}

resource "kubernetes_service_account" "app" {
  metadata {
    name      = "market-sense-app"
    namespace = kubernetes_namespace.this.metadata[0].name
    labels    = local.labels
  }
  automount_service_account_token = false
}

resource "kubernetes_network_policy" "default_deny_ingress" {
  metadata {
    name      = "default-deny-ingress"
    namespace = kubernetes_namespace.this.metadata[0].name
    labels    = local.labels
  }
  spec {
    pod_selector {}
    policy_types = ["Ingress"]
  }
}

resource "kubernetes_network_policy" "allow_ingress_controller" {
  metadata {
    name      = "allow-ingress-controller"
    namespace = kubernetes_namespace.this.metadata[0].name
    labels    = local.labels
  }
  spec {
    pod_selector {
      match_labels = {
        "app.kubernetes.io/part-of" = "market-sense"
      }
    }
    policy_types = ["Ingress"]
    ingress {
      from {
        namespace_selector {
          match_labels = {
            "kubernetes.io/metadata.name" = var.ingress_namespace
          }
        }
      }
      ports {
        port     = "http"
        protocol = "TCP"
      }
    }
  }
}

output "namespace" {
  value = kubernetes_namespace.this.metadata[0].name
}

output "service_account" {
  value = kubernetes_service_account.app.metadata[0].name
}

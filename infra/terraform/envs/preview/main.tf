# market-sense-h5 · preview 环境（按 PR 起停，Terraform 1.9.x）
#
# 一个 PR = 一个 namespace = 一套 Helm release（market-sense-preview-pr-<n>）。
# 起：CI preview.yml（pull_request opened/synchronize）terraform apply + helm upgrade。
# 停：PR closed → preview.yml down job → terraform destroy（namespace 整体回收）。
# 设计要点：preview 生命周期短、配额小、禁止访问生产数据源（用 fixture/mock 数据）。
terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "2.33.0"
    }
  }
  # preview state 按 PR 分开；CI 用 -state=<工作目录>/pr-<n>.tfstate，避免多 PR 串 state
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "kubernetes" {
  config_path = var.kubeconfig_path
}

variable "kubeconfig_path" {
  description = "kubeconfig 路径；null 表示使用默认 KUBECONFIG / in-cluster"
  type        = string
  default     = null
  nullable    = true
}

variable "pr_number" {
  description = "PR 号（由 CI 传入，必填）"
  type        = number
  validation {
    condition     = var.pr_number > 0
    error_message = "pr_number 必须为正整数（preview 按 PR 隔离）。"
  }
}

variable "ttl_hours" {
  description = "preview 最长存活时间（小时），超时由 preview-reap 定时清理兜底（成本约束：磁盘有限）"
  type        = number
  default     = 24

  validation {
    condition     = var.ttl_hours >= 1 && var.ttl_hours <= 72
    error_message = "ttl_hours 必须在 1..72 之间；默认 24h，延长需在 PR 中说明成本理由。"
  }
}

locals {
  namespace = "market-sense-preview-pr-${var.pr_number}"
}

module "environment" {
  source                = "../../modules/k8s-environment"
  namespace             = local.namespace
  environment           = "preview"
  pr_number             = var.pr_number
  quota_pods            = "8"
  quota_requests_cpu    = "2"
  quota_requests_memory = "4Gi"
  quota_limits_cpu      = "4"
  quota_limits_memory   = "8Gi"
  ingress_namespace     = "ingress-nginx"
}

output "namespace" {
  value = module.environment.namespace
}

output "preview_host" {
  value = "pr-${var.pr_number}.preview.market-sense.invalid"
}

# market-sense-h5 · dev 环境（Terraform 1.9.x）
#
# 本档只做「环境底座」：namespace / 配额 / ServiceAccount / NetworkPolicy。
# 应用发布：helm upgrade --install（见 infra/scripts/deploy.sh），可回滚、可重复。
# state：S0 使用 local backend（本机 .tfstate，已 gitignore）；S1 接远端前必须先迁移：
#   backend "s3" { bucket=... key="market-sense/dev/terraform.tfstate" region=... dynamodb_table=... }
#   —— 涉及生产前必须由 A13 提案、H5 批准，禁止带 local state 直接 apply 生产。
terraform {
  required_version = ">= 1.9.0, < 2.0.0"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "2.33.0"
    }
  }
  backend "local" {
    path = "terraform.tfstate"
  }
}

provider "kubernetes" {
  # 本地/CI 通过 KUBECONFIG 注入；集群内运行留空即 in-cluster
  config_path = var.kubeconfig_path
}

variable "kubeconfig_path" {
  description = "kubeconfig 路径；null 表示使用默认 KUBECONFIG / in-cluster"
  type        = string
  default     = null
  nullable    = true
}

variable "namespace" {
  type    = string
  default = "market-sense-dev"
}

module "environment" {
  source                = "../../modules/k8s-environment"
  namespace             = var.namespace
  environment           = "dev"
  pr_number             = 0
  quota_pods            = "30"
  quota_requests_cpu    = "8"
  quota_requests_memory = "16Gi"
  quota_limits_cpu      = "16"
  quota_limits_memory   = "32Gi"
  ingress_namespace     = "ingress-nginx"
}

output "namespace" {
  value = module.environment.namespace
}

output "service_account" {
  value = module.environment.service_account
}

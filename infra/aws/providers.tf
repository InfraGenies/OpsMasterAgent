terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  # Local state for a single-demo-environment app, matching this repo's own
  # "no unnecessary infra" bias. Switch to an S3 backend if this ever needs
  # to be applied from more than one machine.
}

provider "aws" {
  region = var.aws_region
}

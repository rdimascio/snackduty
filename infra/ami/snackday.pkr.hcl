packer {
  required_plugins {
    amazon = {
      version = "= 1.3.9"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Supply the reviewed AWS account ID."
  }
}
variable "region" { type = string }
variable "base_ami" { type = string }
variable "subnet_id" { type = string }
variable "security_group_id" { type = string }
variable "inputs" { type = string }
variable "release_commit" { type = string }
variable "artifact_digest" { type = string }

source "amazon-ebs" "staging" {
  allowed_account_ids = [var.account_id]
  region              = var.region
  source_ami          = var.base_ami
  instance_type       = "t3.small"
  ssh_username        = "ubuntu"
  subnet_id           = var.subnet_id
  security_group_id   = var.security_group_id
  ami_name            = "snackday-${var.release_commit}-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  encrypt_boot        = true
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }
  tags = {
    Application   = "snackday"
    ReleaseCommit = var.release_commit
    ReleaseDigest = var.artifact_digest
    BaseAMI       = var.base_ami
  }
}

build {
  sources = ["source.amazon-ebs.staging"]
  provisioner "file" {
    source      = var.inputs
    destination = "/tmp/snackday-inputs"
  }
  provisioner "shell" {
    inline = ["sudo bash /tmp/snackday-inputs/install-image.sh /tmp/snackday-inputs"]
  }
  post-processor "manifest" { output = "ami-receipt.json" }
}

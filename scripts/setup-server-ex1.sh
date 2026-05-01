#!/bin/bash

# Minecraft Dashboard Installation Script
# This script automates the setup of the dashboard on a fresh Linux box
# Usage: ./scripts/install.sh

set -euo pipefail
IFS=$'\n\t'

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

die() {
    log_error "$@"
    exit 1
}

require_cmd() {
    if ! command -v "$1" &> /dev/null; then
        return 1
    fi
    return 0
}

check_root() {
    if [ "$EUID" -eq 0 ]; then
        die "This script should NOT be run as root. Run as your normal user."
    fi
}

# ========================================
# Main installation flow
# ========================================

main() {
    log_info "Starting Minecraft Dashboard Installation"
    
    check_root
    
    # Step 1: Check and install system packages
    step_install_system_packages
    
    # Step 2: Enable user-level systemd services
    step_enable_user_services
    
    # Step 3: Set up dashboard directory
    step_setup_dashboard_dir
    
    # Step 4: Install npm dependencies
    step_install_npm_dependencies
    
    # Step 5: Configure environment
    step_configure_environment
    
    # Step 6: Create initial super-operator user
    step_create_initial_user
    
    # Step 7: Set up systemd service
    step_setup_systemd_service
    
    log_info "${GREEN}Installation complete!${NC}"
    log_info "Dashboard should be running on 127.0.0.1:8080"
    log_info "Next steps:"
    log_info "  1. Set up Cloudflare Tunnel (see README.md)"
    log_info "  2. Add Minecraft servers using: ./scripts/add-server.sh"
}

# ========================================
# Installation Steps
# ========================================

step_install_system_packages() {
    log_info "Checking and installing system packages..."
    
    local missing_packages=()
    local missing_commands=()
    
    # Check for required commands
    require_cmd "git" || missing_commands+=("git")
    require_cmd "java" || missing_commands+=("openjdk-21-jre-headless")
    require_cmd "sqlite3" || missing_commands+=("sqlite3")
    require_cmd "node" || missing_commands+=("nodejs")
    require_cmd "curl" || missing_commands+=("curl")
    
    if [ ${#missing_commands[@]} -gt 0 ]; then
        log_warn "Some system packages are missing. Installing with apt..."
        
        sudo apt update
        sudo apt upgrade -y
        
        local apt_packages=(
            "curl"
            "git"
            "openjdk-21-jre-headless"
            "sqlite3"
            "build-essential"
        )
        
        # Install Node.js 20.x if not present
        if ! require_cmd "node"; then
            log_info "Setting up Node.js 20.x repository..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            apt_packages+=("nodejs")
        fi
        
        sudo apt install -y "${apt_packages[@]}"
    fi
    
    # Verify versions
    log_info "Verifying installed versions..."
    local node_version=$(node --version)
    log_info "  Node.js: $node_version"
    local java_version=$(java -version 2>&1 | grep version | head -n1)
    log_info "  Java: $java_version"
}

step_enable_user_services() {
    log_info "Enabling user-level systemd services..."
    
    if ! systemctl --user show-environment &> /dev/null; then
        log_warn "User systemd services not available. Enabling lingering..."
        sudo loginctl enable-linger "$USER"
    else
        log_info "User systemd services already enabled"
    fi
}

step_setup_dashboard_dir() {
    log_info "Setting up dashboard directory..."
    
    local dashboard_dir="/srv/dashboard"
    
    if [ ! -d "$dashboard_dir" ]; then
        sudo mkdir -p "$dashboard_dir"
        sudo chown -R "$USER:$USER" "$dashboard_dir"
        log_info "Created $dashboard_dir"
    else
        log_info "$dashboard_dir already exists"
    fi
    
    # Copy dashboard files if not already there
    if [ ! -f "$dashboard_dir/server.js" ]; then
        log_info "Copying dashboard files to $dashboard_dir..."
        
        # Get the directory where this script is located
        local script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
        
        # Copy all files except node_modules
        cp -r "$script_dir"/* "$dashboard_dir/" 2>/dev/null || true
        cp -r "$script_dir"/.[^.]* "$dashboard_dir/" 2>/dev/null || true
        
        log_info "Dashboard files copied"
    fi
}

step_install_npm_dependencies() {
    log_info "Installing npm dependencies..."
    
    cd /srv/dashboard
    
    if [ ! -d "node_modules" ]; then
        npm install
        log_info "npm dependencies installed"
    else
        log_info "npm dependencies already installed"
    fi
}

step_configure_environment() {
    log_info "Configuring environment..."
    
    local env_file="/srv/dashboard/.env"
    
    if [ ! -f "$env_file" ]; then
        log_info "Creating .env file..."
        cp /srv/dashboard/.env.example "$env_file"
        
        # Generate a random session secret
        local session_secret=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
        
        # Update SESSION_SECRET in .env (handle both quoted and unquoted values)
        sed -i "s/SESSION_SECRET=.*/SESSION_SECRET=$session_secret/" "$env_file"
        
        log_warn "Please edit $env_file and set:"
        log_warn "  1. RCON_PASSWORD_VANILLA (or other RCON passwords)"
        log_warn "  2. TERMINAL_ENABLED (optional, set to 'true' to enable)"
        log_info "Launching nano editor..."
        nano "$env_file"
    else
        log_info ".env file already exists"
    fi
}

step_create_initial_user() {
    log_info "Creating initial super-operator user..."
    
    cd /srv/dashboard
    
    read -p "Enter username for super-operator: " username
    
    if [ -z "$username" ]; then
        log_warn "Skipping user creation (empty username)"
        return
    fi
    
    if node scripts/create-user.js "$username" --super; then
        log_info "Super-operator user '$username' created successfully"
    else
        log_warn "Failed to create user (may already exist)"
    fi
}

step_setup_systemd_service() {
    log_info "Setting up systemd service..."
    
    local user_systemd_dir="$HOME/.config/systemd/user"
    
    mkdir -p "$user_systemd_dir"
    
    if [ ! -f "$user_systemd_dir/dashboard.service" ]; then
        cp /srv/dashboard/systemd/dashboard.service "$user_systemd_dir/"
        log_info "Service file copied"
    fi
    
    systemctl --user daemon-reload
    systemctl --user enable --now dashboard
    
    # Wait a moment for the service to start
    sleep 2
    
    if systemctl --user is-active --quiet dashboard; then
        log_info "${GREEN}Dashboard service is running!${NC}"
        systemctl --user status dashboard
    else
        log_error "Dashboard service failed to start"
        systemctl --user status dashboard
        return 1
    fi
}

# Run main function
main "$@"

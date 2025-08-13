#!/bin/bash
# Use Minikube's Docker
eval $(minikube docker-env)

# Build all services
docker build -t order-service:latest ./order-service
docker build -t payment-service:latest ./payment-service
docker build -t user-service:latest ./user-service

# Apply Kubernetes configs
kubectl apply -f k8s/
kubectl apply -f services/

# Restart deployments so they pick up new images
kubectl rollout restart deployment -n default

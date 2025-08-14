#!/bin/bash
# Use Minikube's Docker
eval $(minikube docker-env)

# Build all services
# docker build -t order-service:1.0.27 ./order-service
# docker build -t payment-service:1.0.27 ./payment-service
docker build -t user-service:1.0.28 ./user-service

# Apply Kubernetes manifests
kubectl apply -f k8s/
kubectl apply -f services/
kubectl apply -f ingress-setup.yaml   # apply ingress

# Restart deployments so they pick up new images
kubectl rollout restart deployment -n default

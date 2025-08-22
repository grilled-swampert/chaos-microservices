#!/bin/bash
# Use Minikube's Docker
eval $(minikube docker-env)

# Build all services
docker build -t order-service:1.0.32 ./order-service
docker build -t payment-service:1.0.32 ./payment-service
docker build -t user-service:1.0.32 ./user-service

# Apply Kubernetes manifests
kubectl apply -f k8s/
kubectl apply -f services/
kubectl apply -f ingress-setup.yaml   # apply ingress

# Restart deployments so they pick up new images
kubectl rollout restart deployment -n default

# #!/bin/bash
# set -e

# # Use Minikube's Docker
# eval $(minikube docker-env)

# SERVICES=("order-service" "payment-service" "user-service")
# IMAGE_TAG=$(git rev-parse --short HEAD)

# # Build all services
# for service in "${SERVICES[@]}"; do
#   echo "👉 Building $service..."
#   docker build -t $service:$IMAGE_TAG ./$service
# done

# # Apply manifests
# kubectl apply -f k8s/
# kubectl apply -f services/
# kubectl apply -f ingress-setup.yaml

# # Update deployments with new images
# for service in "${SERVICES[@]}"; do
#   echo "👉 Updating $service..."
#   kubectl set image deployment/$service $service=$service:$IMAGE_TAG
# done

# echo "✅ All services deployed with tag $IMAGE_TAG"

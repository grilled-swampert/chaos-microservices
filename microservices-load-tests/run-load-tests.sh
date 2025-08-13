#!/bin/bash

# K6 Load Test Runner for Microservices Chaos Testing
# This script runs comprehensive load tests while you perform chaos experiments

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
RESULTS_DIR="./load-test-results"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$RESULTS_DIR/load-test-$TIMESTAMP.log"

# Default values
RUN_INDIVIDUAL=false
RUN_COMPREHENSIVE=true
DURATION=""
VUS=""
SERVICES_CHECK=true

print_banner() {
    echo -e "${BLUE}"
    echo "=================================================="
    echo "  Microservices Load Testing for Chaos Testing"
    echo "=================================================="
    echo -e "${NC}"
}

print_help() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -i, --individual      Run individual service tests"
    echo "  -c, --comprehensive   Run comprehensive multi-service test (default)"
    echo "  -a, --all             Run all tests (individual + comprehensive)"
    echo "  -d, --duration MINS   Override test duration in minutes"
    echo "  -u, --users COUNT     Override max virtual users"
    echo "  --no-services-check   Skip services health check"
    echo "  -h, --help            Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0 -c                     # Run comprehensive test"
    echo "  $0 -i                     # Run individual service tests"
    echo "  $0 -a -d 30 -u 50         # Run all tests for 30 mins with 50 users max"
    echo "  $0 -c --no-services-check # Skip health check and run comprehensive test"
}

check_dependencies() {
    echo -e "${YELLOW}Checking dependencies...${NC}"
    
    if ! command -v k6 &> /dev/null; then
        echo -e "${RED}Error: k6 is not installed.${NC}"
        echo "Please install k6 from https://k6.io/docs/getting-started/installation/"
        exit 1
    fi
    
    if ! command -v curl &> /dev/null; then
        echo -e "${RED}Error: curl is not installed.${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}Dependencies check passed.${NC}"
}

check_services() {
    if [ "$SERVICES_CHECK" = false ]; then
        echo -e "${YELLOW}Skipping services health check.${NC}"
        return
    fi
    
    echo -e "${YELLOW}Checking microservices health...${NC}"
    
    services=("59842:User" "58231:Order" "58179:Payment")
    failed_services=()
    
    for service in "${services[@]}"; do
        port=${service%%:*}
        name=${service##*:}
        
        if curl -sf "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ $name Service (port $port) is healthy${NC}"
        else
            echo -e "${RED}✗ $name Service (port $port) is not responding${NC}"
            failed_services+=("$name")
        fi
    done
    
    if [ ${#failed_services[@]} -gt 0 ]; then
        echo -e "${YELLOW}Warning: Some services are not healthy: ${failed_services[*]}${NC}"
        echo -e "${YELLOW}This is expected if you're running chaos experiments.${NC}"
        echo -e "${YELLOW}Load tests will continue and help measure resilience.${NC}"
        sleep 3
    else
        echo -e "${GREEN}All services are healthy. Ready for load testing!${NC}"
    fi
}

setup_results_dir() {
    mkdir -p "$RESULTS_DIR"
    echo -e "${BLUE}Results will be saved to: $RESULTS_DIR${NC}"
    echo -e "${BLUE}Log file: $LOG_FILE${NC}"
}

run_individual_tests() {
    echo -e "${YELLOW}Running individual service load tests...${NC}"
    
    # User Service Test
    echo -e "${BLUE}Starting User Service load test...${NC}"
    k6 run --out json="$RESULTS_DIR/user-service-$TIMESTAMP.json" \
           user-service-load-test.js 2>&1 | tee -a "$LOG_FILE"
    
    echo -e "${GREEN}User Service test completed.${NC}"
    sleep 5
    
    # Order Service Test
    echo -e "${BLUE}Starting Order Service load test...${NC}"
    k6 run --out json="$RESULTS_DIR/order-service-$TIMESTAMP.json" \
           order-service-load-test.js 2>&1 | tee -a "$LOG_FILE"
    
    echo -e "${GREEN}Order Service test completed.${NC}"
    sleep 5
    
    # Payment Service Test
    echo -e "${BLUE}Starting Payment Service load test...${NC}"
    k6 run --out json="$RESULTS_DIR/payment-service-$TIMESTAMP.json" \
           payment-service-load-test.js 2>&1 | tee -a "$LOG_FILE"
    
    echo -e "${GREEN}Payment Service test completed.${NC}"
}

run_comprehensive_test() {
    echo -e "${YELLOW}Running comprehensive multi-service load test...${NC}"
    echo -e "${BLUE}This test simulates realistic user workflows across all services.${NC}"
    
    local k6_options=""
    
    if [ -n "$DURATION" ]; then
        # Override duration in the options
        k6_options="--duration ${DURATION}m"
        echo -e "${YELLOW}Using custom duration: ${DURATION} minutes${NC}"
    fi
    
    if [ -n "$VUS" ]; then
        # Override max VUs
        k6_options="$k6_options --vus $VUS"
        echo -e "${YELLOW}Using custom max VUs: ${VUS}${NC}"
    fi
    
    k6 run $k6_options \
           --out json="$RESULTS_DIR/comprehensive-$TIMESTAMP.json" \
           comprehensive-load-test.js 2>&1 | tee -a "$LOG_FILE"
    
    echo -e "${GREEN}Comprehensive test completed.${NC}"
}

monitor_system() {
    echo -e "${YELLOW}Starting system monitoring (runs in background)...${NC}"
    
    # Monitor system resources and save to file
    (
        echo "timestamp,cpu_usage,memory_usage,load_avg" > "$RESULTS_DIR/system-metrics-$TIMESTAMP.csv"
        while true; do
            timestamp=$(date '+%Y-%m-%d %H:%M:%S')
            cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
            memory_usage=$(free | grep Mem | awk '{printf("%.1f", $3/$2 * 100.0)}')
            load_avg=$(uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | sed 's/,//')
            
            echo "$timestamp,$cpu_usage,$memory_usage,$load_avg" >> "$RESULTS_DIR/system-metrics-$TIMESTAMP.csv"
            sleep 10
        done
    ) &
    
    MONITOR_PID=$!
    echo -e "${GREEN}System monitoring started (PID: $MONITOR_PID)${NC}"
}

stop_monitoring() {
    if [ -n "$MONITOR_PID" ]; then
        kill $MONITOR_PID 2>/dev/null || true
        echo -e "${YELLOW}System monitoring stopped.${NC}"
    fi
}

run_chaos_experiment_suggestions() {
    echo -e "${BLUE}"
    echo "=================================================="
    echo "  CHAOS EXPERIMENT SUGGESTIONS"
    echo "=================================================="
    echo -e "${NC}"
    echo "While the load tests are running, try these chaos experiments:"
    echo ""
    echo -e "${YELLOW}1. Container Failures:${NC}"
    echo "   docker stop <user-service-container>"
    echo "   docker stop <order-service-container>"
    echo "   docker stop <payment-service-container>"
    echo ""
    echo -e "${YELLOW}2. Network Partitions:${NC}"
    echo "   # Block traffic between services"
    echo "   sudo iptables -A INPUT -p tcp --dport 59842 -j DROP"
    echo "   sudo iptables -A INPUT -p tcp --dport 58179 -j DROP"
    echo ""
    echo -e "${YELLOW}3. Resource Exhaustion:${NC}"
    echo "   # Limit container memory"
    echo "   docker update --memory=100m <container-name>"
    echo ""
    echo -e "${YELLOW}4. Latency Injection:${NC}"
    echo "   # Add network delay using tc (traffic control)"
    echo "   sudo tc qdisc add dev lo root netem delay 100ms"
    echo ""
    echo -e "${YELLOW}5. CPU Stress:${NC}"
    echo "   # Install stress tool and run in container"
    echo "   docker exec <container> stress --cpu 4"
    echo ""
    echo -e "${GREEN}The load tests will continue running and measure how your system responds!${NC}"
    echo ""
}

generate_summary_report() {
    echo -e "${YELLOW}Generating summary report...${NC}"
    
    local report_file="$RESULTS_DIR/summary-report-$TIMESTAMP.md"
    
    cat > "$report_file" << EOF
# Load Test Summary Report

**Timestamp:** $(date)  
**Test Duration:** $(if [ -n "$DURATION" ]; then echo "${DURATION} minutes"; else echo "Default duration"; fi)  
**Max Virtual Users:** $(if [ -n "$VUS" ]; then echo "$VUS"; else echo "Default VUs"; fi)

## Test Configuration

- **Individual Tests:** $(if [ "$RUN_INDIVIDUAL" = true ]; then echo "✓ Executed"; else echo "✗ Skipped"; fi)
- **Comprehensive Test:** $(if [ "$RUN_COMPREHENSIVE" = true ]; then echo "✓ Executed"; else echo "✗ Skipped"; fi)
- **Services Health Check:** $(if [ "$SERVICES_CHECK" = true ]; then echo "✓ Enabled"; else echo "✗ Disabled"; fi)

## Files Generated

- Log file: \`load-test-$TIMESTAMP.log\`
- System metrics: \`system-metrics-$TIMESTAMP.csv\`
EOF

    if [ "$RUN_INDIVIDUAL" = true ]; then
        echo "- User service results: \`user-service-$TIMESTAMP.json\`" >> "$report_file"
        echo "- Order service results: \`order-service-$TIMESTAMP.json\`" >> "$report_file"
        echo "- Payment service results: \`payment-service-$TIMESTAMP.json\`" >> "$report_file"
    fi
    
    if [ "$RUN_COMPREHENSIVE" = true ]; then
        echo "- Comprehensive test results: \`comprehensive-$TIMESTAMP.json\`" >> "$report_file"
    fi
    
    cat >> "$report_file" << EOF

## Analysis Commands

To analyze the results, use these commands:

\`\`\`bash
# View JSON results with jq
cat $RESULTS_DIR/comprehensive-$TIMESTAMP.json | jq '.metrics'

# Generate HTML report (if k6 supports it)
k6 run --out html=$RESULTS_DIR/report-$TIMESTAMP.html comprehensive-load-test.js

# View system metrics
cat $RESULTS_DIR/system-metrics-$TIMESTAMP.csv
\`\`\`

## Chaos Engineering Recommendations

Based on this load test, consider these chaos experiments:

1. **Service Isolation:** Test behavior when individual services fail
2. **Network Partitions:** Verify graceful degradation during network issues
3. **Resource Constraints:** Test performance under memory/CPU pressure
4. **Database Failures:** Simulate data store unavailability
5. **Latency Injection:** Test timeout handling and retry mechanisms

## Next Steps

1. Analyze the JSON results to identify performance bottlenecks
2. Review error patterns during chaos experiments
3. Adjust service timeouts and retry policies based on findings
4. Implement circuit breakers where needed
5. Set up monitoring and alerting based on observed thresholds
EOF

    echo -e "${GREEN}Summary report generated: $report_file${NC}"
}

cleanup() {
    echo -e "${YELLOW}Cleaning up...${NC}"
    stop_monitoring
    echo -e "${GREEN}Cleanup completed.${NC}"
}

# Trap to ensure cleanup on script exit
trap cleanup EXIT

main() {
    print_banner
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -i|--individual)
                RUN_INDIVIDUAL=true
                RUN_COMPREHENSIVE=false
                shift
                ;;
            -c|--comprehensive)
                RUN_COMPREHENSIVE=true
                RUN_INDIVIDUAL=false
                shift
                ;;
            -a|--all)
                RUN_INDIVIDUAL=true
                RUN_COMPREHENSIVE=true
                shift
                ;;
            -d|--duration)
                DURATION="$2"
                shift 2
                ;;
            -u|--users)
                VUS="$2"
                shift 2
                ;;
            --no-services-check)
                SERVICES_CHECK=false
                shift
                ;;
            -h|--help)
                print_help
                exit 0
                ;;
            *)
                echo -e "${RED}Unknown option: $1${NC}"
                print_help
                exit 1
                ;;
        esac
    done
    
    # Main execution flow
    check_dependencies
    setup_results_dir
    check_services
    
    echo -e "${BLUE}Starting load tests at $(date)${NC}"
    
    # Start system monitoring
    monitor_system
    
    # Show chaos experiment suggestions
    run_chaos_experiment_suggestions
    
    # Run the selected tests
    if [ "$RUN_INDIVIDUAL" = true ]; then
        run_individual_tests
    fi
    
    if [ "$RUN_COMPREHENSIVE" = true ]; then
        run_comprehensive_test
    fi
    
    # Generate summary
    generate_summary_report
    
    echo -e "${GREEN}"
    echo "=================================================="
    echo "  Load testing completed successfully!"
    echo "=================================================="
    echo -e "${NC}"
    echo "Results saved to: $RESULTS_DIR"
    echo "Check the summary report for detailed analysis."
    echo ""
    echo -e "${YELLOW}Continue running your chaos experiments while monitoring the results!${NC}"
}

# Check if the script is being run directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
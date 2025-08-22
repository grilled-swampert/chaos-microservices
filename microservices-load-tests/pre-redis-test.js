import http from "k6/http";
import { sleep } from "k6";
import { check } from "k6";

export let options = {
  vus: 50, // number of virtual users
  duration: "30s", // test duration
};

export default function () {
  let res = http.get("http://microservices.local/orders/orders");
  check(res, { "status is 200": (r) => r.status === 200 });
  sleep(1);
}

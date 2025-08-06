import http from "http";

const port = 9090;

const server = http.createServer((req, res) => {
  setTimeout(() => {
    // random chance of failure
    if (Math.random() < 0.1) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("Internal Server Error\n");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("Hello, world!\n");
  }, 500);
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});

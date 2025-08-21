import http from "http";

const port = 9090;

const server = http.createServer((req, res) => {
  setTimeout(() => {
    const randomNumber = Math.random();
    // random chance of failure
    if (randomNumber < 0.1) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      res.end("Internal Server Error\n");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        result: randomNumber.toFixed(2),
      })
    );
  }, 500);
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}/`);
});

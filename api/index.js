const express = require('express');
const app = express();
app.use(express.json());

app.get('/files', (req, res) => res.json([]));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Running on ${port}`));
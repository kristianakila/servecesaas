import express from "express";
import cors from "cors";

import { spinHandler } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/:botId", spinHandler);
app.use("/api/:botId/admin", adminRouter);

app.listen(8000, () => console.log("Backend started on 8000"));

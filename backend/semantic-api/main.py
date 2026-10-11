"""Small self-hosted Chinese embedding service for candidate retrieval only."""
from __future__ import annotations

import os
from functools import lru_cache
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from ranking import rank_candidates

MODEL_NAME = os.getenv("SEMANTIC_MODEL_NAME", "BAAI/bge-small-zh-v1.5")


class Candidate(BaseModel):
    id: str
    text: str = Field(min_length=1, max_length=2000)


class RankRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    candidates: List[Candidate] = Field(min_length=1, max_length=256)
    min_score: float = Field(default=0.78, ge=0.0, le=1.0)


class RankMatch(BaseModel):
    id: str
    score: float


class RankResponse(BaseModel):
    model: str
    matches: List[RankMatch]


@lru_cache(maxsize=1)
def get_model():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=MODEL_NAME, cache_dir=os.getenv("SEMANTIC_MODEL_CACHE", "/models"))


@lru_cache(maxsize=1024)
def embed_candidate(text: str):
    return tuple(float(value) for value in next(get_model().passage_embed([text])).tolist())


app = FastAPI(title="Maiduo semantic candidate service", version="1.0.0")


@app.on_event("startup")
def load_embedding_model():
    # Load/download before reporting healthy; compose readiness must mean inference is usable.
    get_model()


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "loaded": get_model.cache_info().currsize > 0}


@app.post("/v1/rank", response_model=RankResponse)
def rank(request: RankRequest):
    try:
        model = get_model()
        query_embedding = list(model.query_embed([request.query]))[0].tolist()
        candidate_embeddings = [embed_candidate(candidate.text) for candidate in request.candidates]
        matches = rank_candidates(
            query_embedding,
            [candidate.model_dump() if hasattr(candidate, "model_dump") else candidate.dict() for candidate in request.candidates],
            candidate_embeddings,
            request.min_score,
        )
        return RankResponse(model=MODEL_NAME, matches=[RankMatch(**item) for item in matches])
    except Exception as exc:  # Surface model/download errors without leaking request text.
        raise HTTPException(status_code=503, detail=f"embedding model unavailable: {type(exc).__name__}") from exc

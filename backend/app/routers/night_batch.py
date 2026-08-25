"""夜间批量调用登记处：登记/查询/删除计划中的夜间批量调用时段。"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_user
from app.database import get_db
from app.models import ModelRegistryORM, NightBatchRegistrationORM, _uuid

router = APIRouter(prefix="/night-batch", tags=["night-batch"])

MAX_OCCURRENCES = 60


class NightBatchCreateIn(BaseModel):
    start_date: str  # "YYYY-MM-DD"
    start_time: str  # "HH:MM"
    end_time: str  # "HH:MM"；<= start_time 视为次日结束（跨夜窗口）
    repeat_weekdays: list[int] = Field(default_factory=list)  # 0=周一..6=周日；空=不重复
    repeat_until: str | None = None  # "YYYY-MM-DD"；repeat_weekdays 非空时必填
    model_id: str = Field(min_length=1)
    description: str = Field(min_length=1, max_length=300)
    contact_name: str = Field(min_length=1, max_length=50)
    intensity_note: str | None = Field(default=None, max_length=100)


class NightBatchUpdateIn(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=300)
    intensity_note: str | None = Field(default=None, max_length=100)
    contact_name: str | None = Field(default=None, min_length=1, max_length=50)


def _expand_occurrences(
    start_date_v: date,
    start_time_v,
    end_time_v,
    repeat_weekdays: list[int],
    repeat_until_v: date | None,
) -> list[tuple[datetime, datetime]]:
    crosses_midnight = end_time_v <= start_time_v

    if not repeat_weekdays:
        dates = [start_date_v]
    else:
        if repeat_until_v is None:
            raise HTTPException(status_code=400, detail="选择了重复星期时必须填写重复截止日期")
        if repeat_until_v < start_date_v:
            raise HTTPException(status_code=400, detail="重复截止日期不能早于开始日期")
        dates = []
        cur = start_date_v
        while cur <= repeat_until_v:
            if cur.weekday() in repeat_weekdays:
                dates.append(cur)
            cur += timedelta(days=1)
        if not dates:
            raise HTTPException(status_code=400, detail="所选重复规则在该日期范围内没有匹配的场次")

    if len(dates) > MAX_OCCURRENCES:
        raise HTTPException(
            status_code=400,
            detail=f"重复规则将生成 {len(dates)} 场登记，超过单次最多 {MAX_OCCURRENCES} 场的上限，请缩短重复范围",
        )

    occurrences = []
    for d in dates:
        s = datetime.combine(d, start_time_v)
        e = datetime.combine(d + timedelta(days=1 if crosses_midnight else 0), end_time_v)
        occurrences.append((s, e))
    return occurrences


def _dict(r: NightBatchRegistrationORM) -> dict:
    return {
        "id": r.id,
        "series_id": r.series_id,
        "series_total": r.series_total,
        "creator_auth_id": r.creator_auth_id,
        "creator_name": r.creator_name,
        "project": r.project,
        "model_id": r.model_id,
        "model_name": r.model_name,
        "contact_name": r.contact_name,
        "description": r.description,
        "intensity_note": r.intensity_note,
        "start_at": r.start_at.isoformat() if r.start_at else None,
        "end_at": r.end_at.isoformat() if r.end_at else None,
        "repeat_weekdays": r.repeat_weekdays,
        "repeat_until": r.repeat_until.isoformat() if r.repeat_until else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("")
def list_night_batch(
    limit: int = 20,
    offset: int = 0,
    overlap_start: str | None = Query(default=None),
    overlap_end: str | None = Query(default=None),
    model_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    conds = []
    if overlap_start and overlap_end:
        try:
            ov_start = datetime.fromisoformat(overlap_start)
            ov_end = datetime.fromisoformat(overlap_end)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="overlap_start / overlap_end 格式不正确") from exc
        # 半开区间 [start_at, end_at) 与 [ov_start, ov_end) 相交
        conds.append(NightBatchRegistrationORM.start_at < ov_end)
        conds.append(NightBatchRegistrationORM.end_at > ov_start)
    if model_id:
        # 冲突检测按模型收窄：不同模型的时段重叠不构成资源冲突
        conds.append(NightBatchRegistrationORM.model_id == model_id)

    base_q = select(NightBatchRegistrationORM)
    total_q = select(func.count()).select_from(NightBatchRegistrationORM)
    if conds:
        base_q = base_q.where(*conds)
        total_q = total_q.where(*conds)

    total = int(db.scalar(total_q) or 0)
    rows = db.execute(
        base_q.order_by(
            NightBatchRegistrationORM.start_at.desc(),
            NightBatchRegistrationORM.created_at.desc(),
        ).limit(limit).offset(offset)
    ).scalars().all()

    return {"total": total, "limit": limit, "offset": offset, "data": [_dict(r) for r in rows]}


@router.post("")
def create_night_batch(
    payload: NightBatchCreateIn,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    try:
        start_date_v = date.fromisoformat(payload.start_date)
        start_time_v = datetime.strptime(payload.start_time, "%H:%M").time()
        end_time_v = datetime.strptime(payload.end_time, "%H:%M").time()
        repeat_until_v = date.fromisoformat(payload.repeat_until) if payload.repeat_until else None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="日期/时间格式不正确") from exc

    if start_time_v == end_time_v:
        raise HTTPException(status_code=400, detail="结束时间不能与开始时间相同")

    model = db.get(ModelRegistryORM, payload.model_id)
    if model is None:
        raise HTTPException(status_code=400, detail="所选模型不存在")

    weekdays = sorted({w for w in payload.repeat_weekdays if 0 <= w <= 6})
    occurrences = _expand_occurrences(start_date_v, start_time_v, end_time_v, weekdays, repeat_until_v)

    series_id = _uuid()
    # 身份取自登录态，禁止伪造 auth_id
    auth_id = (claims.get("sub") or "").strip()
    creator_name = (claims.get("name") or auth_id).strip()
    project = (claims.get("department") or "").strip()

    rows = [
        NightBatchRegistrationORM(
            series_id=series_id,
            series_total=len(occurrences),
            creator_auth_id=auth_id,
            creator_name=creator_name,
            project=project,
            model_id=model.id,
            model_name=model.name,
            contact_name=payload.contact_name.strip(),
            description=payload.description.strip(),
            intensity_note=((payload.intensity_note or "").strip() or None),
            start_at=s,
            end_at=e,
            repeat_weekdays=weekdays or None,
            repeat_until=repeat_until_v,
        )
        for s, e in occurrences
    ]
    db.add_all(rows)
    db.commit()
    return {"series_id": series_id, "count": len(rows), "data": [_dict(r) for r in rows]}


@router.delete("/series/{series_id}")
def delete_night_batch_series(
    series_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    auth_id = (claims.get("sub") or "").strip()
    rows = db.execute(
        select(NightBatchRegistrationORM).where(NightBatchRegistrationORM.series_id == series_id)
    ).scalars().all()
    if not rows or rows[0].creator_auth_id != auth_id:
        raise HTTPException(status_code=404, detail="登记记录不存在")
    count = len(rows)
    for r in rows:
        db.delete(r)
    db.commit()
    return {"ok": True, "series_id": series_id, "deleted": count}


@router.delete("/{reg_id}")
def delete_night_batch(
    reg_id: str,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    auth_id = (claims.get("sub") or "").strip()
    row = db.get(NightBatchRegistrationORM, reg_id)
    if row is None or row.creator_auth_id != auth_id:
        raise HTTPException(status_code=404, detail="登记记录不存在")
    db.delete(row)
    db.commit()
    return {"ok": True, "id": reg_id}


@router.patch("/series/{series_id}")
def update_night_batch_series(
    series_id: str,
    payload: NightBatchUpdateIn,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    auth_id = (claims.get("sub") or "").strip()
    rows = db.execute(
        select(NightBatchRegistrationORM).where(NightBatchRegistrationORM.series_id == series_id)
    ).scalars().all()
    if not rows or rows[0].creator_auth_id != auth_id:
        raise HTTPException(status_code=404, detail="登记记录不存在")

    updates: dict = {}
    if payload.description is not None:
        updates["description"] = payload.description.strip()
    if payload.intensity_note is not None:
        val = payload.intensity_note.strip()
        updates["intensity_note"] = val if val else None
    if payload.contact_name is not None:
        updates["contact_name"] = payload.contact_name.strip()

    if not updates:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    for r in rows:
        for k, v in updates.items():
            setattr(r, k, v)
    db.commit()

    updated = db.execute(
        select(NightBatchRegistrationORM).where(NightBatchRegistrationORM.series_id == series_id)
    ).scalars().all()
    return {"ok": True, "series_id": series_id, "updated": len(updated), "data": [_dict(r) for r in updated]}


@router.patch("/{reg_id}")
def update_night_batch(
    reg_id: str,
    payload: NightBatchUpdateIn,
    db: Session = Depends(get_db),
    claims: dict = Depends(require_user),
):
    auth_id = (claims.get("sub") or "").strip()
    row = db.get(NightBatchRegistrationORM, reg_id)
    if row is None or row.creator_auth_id != auth_id:
        raise HTTPException(status_code=404, detail="登记记录不存在")

    updates: dict = {}
    if payload.description is not None:
        updates["description"] = payload.description.strip()
    if payload.intensity_note is not None:
        val = payload.intensity_note.strip()
        updates["intensity_note"] = val if val else None
    if payload.contact_name is not None:
        updates["contact_name"] = payload.contact_name.strip()

    if not updates:
        raise HTTPException(status_code=400, detail="没有需要更新的字段")

    for k, v in updates.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return {"ok": True, "id": reg_id, "data": _dict(row)}

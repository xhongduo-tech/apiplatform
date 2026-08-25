"""下游响应分帧：无体状态码不得挂 JSON body。

回归的是这样一个 bug：网关把上游状态码原样塞进 JSONResponse，上游偶发
204/304/205 时就发出一个"带 body 的 204"。starlette 按协议不写
Content-Length，uvicorn 的 h11 随即判定协议冲突并**掐断整条客户端连接**——
同一条 keep-alive 连接上已经发出、还在等响应的后续请求就此石沉大海；经
nginx 上游连接池（keepalive 64）复用时，被掐断的连接还会波及正好复用到它的
其它调用方，表现就是"并发调用互相干扰"。
"""
from __future__ import annotations

import json

import pytest
from starlette.responses import JSONResponse

from app.proxy.common import relay_json


@pytest.mark.parametrize("status", [204, 205, 304])
def test_bodiless_status_carries_no_body(status: int):
    resp = relay_json(status, {"error": "上游异常"}, {"X-Resolved-Model": "m"})
    assert resp.status_code == status
    assert resp.body == b""
    # 要么不声明 Content-Length（204/304），要么声明为 0（205）——两者 h11 都接受；
    # 出问题的是"声明了非零长度却属于无体状态码"。
    assert resp.headers.get("content-length", "0") == "0"
    # 网关自己的头照常带上
    assert resp.headers["X-Resolved-Model"] == "m"


@pytest.mark.parametrize("status", [200, 201, 400, 429, 500, 503])
def test_normal_status_keeps_json_body(status: int):
    payload = {"choices": [{"message": {"content": "hi"}}]}
    resp = relay_json(status, payload, {})
    assert isinstance(resp, JSONResponse)
    assert resp.status_code == status
    assert json.loads(resp.body) == payload


def test_informational_status_is_not_given_a_body():
    """1xx 正常由 httpx 内部消化，兜底同样不能带 body。"""
    resp = relay_json(100, {"x": 1}, {})
    assert resp.body == b""

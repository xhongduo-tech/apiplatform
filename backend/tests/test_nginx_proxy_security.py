from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_nginx_preserves_external_host_port_for_cookie_origin_checks():
    nginx = (ROOT / "nginx/nginx.conf").read_text(encoding="utf-8")

    assert "proxy_set_header Host $host;" not in nginx
    assert nginx.count("proxy_set_header Host $http_host;") == 3

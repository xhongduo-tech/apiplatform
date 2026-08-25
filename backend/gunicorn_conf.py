"""gunicorn 配置：Prometheus 多进程模式的 worker 退出清理。

worker 退出时把它在 PROMETHEUS_MULTIPROC_DIR 里的 gauge 文件标记为 dead，
避免 livesum 聚合持续把已死进程的旧值算进去。counter/histogram 文件保留
（累计语义，重启不清零由 entrypoint 的启动清目录负责）。
"""
from prometheus_client import multiprocess


def child_exit(server, worker):
    multiprocess.mark_process_dead(worker.pid)

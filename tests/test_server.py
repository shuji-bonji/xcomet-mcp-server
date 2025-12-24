"""
Tests for Python server fixes (Fix #3: Port binding, Fix #4: Statistics)
"""
import pytest
import asyncio
import json
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))


class TestStatisticsClarity:
    """Tests for Fix #4: Statistics count clarity"""

    def test_stats_structure(self):
        """Verify the new stats structure has separate API counts"""
        expected_keys = {
            "start_time",
            "model_load_time",
            "evaluate_api_count",
            "detect_errors_api_count",
            "batch_api_count",
            "total_pairs_evaluated",
            "total_inference_time_ms",
        }

        # Import the stats from server
        from server import _stats

        assert set(_stats.keys()) == expected_keys

    def test_initial_stats_values(self):
        """Verify initial stats values are zero"""
        from server import _stats

        assert _stats["evaluate_api_count"] == 0
        assert _stats["detect_errors_api_count"] == 0
        assert _stats["batch_api_count"] == 0
        assert _stats["total_pairs_evaluated"] == 0


class TestPortBinding:
    """Tests for Fix #3: Port binding race condition"""

    def test_server_config_accepts_port_zero(self):
        """Verify server can be configured with port 0 for OS-assigned port"""
        import uvicorn
        from server import app

        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning"
        )
        assert config.port == 0

    @pytest.mark.asyncio
    async def test_async_server_startup_gets_real_port(self):
        """Verify we can get the actual port after async startup"""
        import uvicorn
        from server import app

        config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=0,
            log_level="warning"
        )
        server = uvicorn.Server(config)

        # Start the server
        await server.startup()

        try:
            # Get actual port
            actual_port = None
            if server.servers and server.servers[0].sockets:
                actual_port = server.servers[0].sockets[0].getsockname()[1]

            assert actual_port is not None
            assert actual_port > 0
            assert actual_port != 0  # Should be a real port, not 0

        finally:
            # Cleanup
            await server.shutdown()


class TestEndpointCounting:
    """Integration tests for endpoint counting"""

    @pytest.fixture
    def reset_stats(self):
        """Reset stats before each test"""
        from server import _stats
        _stats["evaluate_api_count"] = 0
        _stats["detect_errors_api_count"] = 0
        _stats["batch_api_count"] = 0
        _stats["total_pairs_evaluated"] = 0
        _stats["total_inference_time_ms"] = 0
        yield
        # Reset after test too
        _stats["evaluate_api_count"] = 0
        _stats["detect_errors_api_count"] = 0
        _stats["batch_api_count"] = 0
        _stats["total_pairs_evaluated"] = 0
        _stats["total_inference_time_ms"] = 0

    def test_stats_endpoint_returns_correct_structure(self, reset_stats):
        """Test /stats endpoint returns the new structure"""
        from fastapi.testclient import TestClient
        from server import app

        client = TestClient(app)
        response = client.get("/stats")

        assert response.status_code == 200
        data = response.json()

        # Check new keys exist
        assert "evaluate_api_count" in data
        assert "detect_errors_api_count" in data
        assert "batch_api_count" in data

        # Check old keys don't exist
        assert "evaluation_count" not in data
        assert "batch_count" not in data


class TestHealthEndpoint:
    """Tests for health endpoint"""

    def test_health_returns_ok(self):
        """Test /health endpoint returns ok status"""
        from fastapi.testclient import TestClient
        from server import app

        client = TestClient(app)
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "model_loaded" in data
        assert "model_name" in data


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
